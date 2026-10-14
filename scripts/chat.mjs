#!/usr/bin/env node
/**
 * eve agent 的命令行客户端。
 *
 *   node scripts/chat.mjs "帮我记一下我喜欢喝美式"
 *   node scripts/chat.mjs --verbose "北京天气怎么样"
 *   node scripts/chat.mjs            # 进入多轮对话
 *
 * 环境变量：
 *   EVE_HOST        默认 http://127.0.0.1:2000
 *   EVE_AUTH_TOKEN  自托管部署需要
 *
 * 退出码：0 成功，1 连接失败或本轮失败。
 */
import { createInterface } from "node:readline/promises";
import process from "node:process";

import { Client } from "eve/client";

const host = process.env.EVE_HOST ?? "http://127.0.0.1:2000";
const token = process.env.EVE_AUTH_TOKEN;
const verbose = process.argv.includes("--verbose");
const messages = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

/**
 * 从失败事件里取出真正的上游错误。
 * eve 会把直连 provider 的 401 包装成「AI Gateway 认证失败」并建议 `eve link`，
 * 那个提示对直连场景是错的；真实原因在 details.apiErrorMessage 里。
 */
function failureOf(event) {
  const data = event.data;
  const details = data?.details;
  if (!details) return null;

  return {
    code: data.code ?? "UNKNOWN",
    status: details.statusCode ?? details.upstreamStatusCode ?? null,
    message: details.apiErrorMessage ?? details.upstreamMessage ?? details.message ?? "(无)",
    hint: details.hint ?? null,
  };
}

/** 只描述有信息量的事件，避免刷屏。 */
function describe(event) {
  switch (event.type) {
    case "turn.started":
      return "轮次开始";
    case "message.completed":
      return `模型输出完成（${event.data.finishReason ?? "?"}）`;
    case "actions.requested": {
      const calls = event.data.actions ?? event.data.calls ?? [];
      const names = calls.map((call) => call.toolName ?? call.name).join(", ");
      return `请求调用工具：${names || "(无)"}`;
    }
    case "action.result": {
      const output = event.data.result?.output ?? event.data.result ?? null;
      return `工具返回：${JSON.stringify(output).slice(0, 240)}`;
    }
    case "step.failed":
    case "turn.failed":
    case "session.failed": {
      const failure = failureOf(event);
      if (!failure) return `${event.type}：${JSON.stringify(event.data).slice(0, 240)}`;
      const status = failure.status === null ? "" : ` HTTP ${failure.status}`;
      return `失败 [${failure.code}]${status}：${failure.message}`;
    }
    case "turn.completed":
      return "轮次结束";
    default:
      return null;
  }
}

/** 同一个失败会同时出现在 step.failed / turn.failed / session.failed，只报一次。 */
function reportFailures(events) {
  const seen = new Set();
  let reported = false;

  for (const event of events) {
    const failure = failureOf(event);
    if (failure === null) continue;

    const key = `${failure.code}|${failure.status}|${failure.message}`;
    if (seen.has(key)) continue;
    seen.add(key);

    console.error(`\n失败 [${failure.code}]${failure.status === null ? "" : ` HTTP ${failure.status}`}`);
    console.error(`  原因：${failure.message}`);
    if (failure.hint) console.error(`  提示：${failure.hint}`);
    reported = true;
  }

  if (reported) {
    console.error("\n直连 provider 时忽略「eve link / AI_GATEWAY_API_KEY」那条提示——");
    console.error("它把上游 401 误判成了 AI Gateway 缺凭据。看上面的「原因」。");
  }

  return reported;
}

async function streamTurn(response) {
  process.stdout.write("助手：");
  let wroteText = false;
  const seenEvents = [];

  for await (const event of response) {
    seenEvents.push(event);

    if (event.type === "message.appended") {
      process.stdout.write(event.data.messageDelta);
      wroteText = true;
      continue;
    }

    if (!verbose) continue;

    const line = describe(event);
    if (line) process.stdout.write(`\n  · ${line}`);
  }

  if (!wroteText) process.stdout.write("(本轮没有文本回复)");
  process.stdout.write("\n");

  return reportFailures(seenEvents);
}

async function collectTurn(response) {
  const result = await response.result();

  if (verbose) {
    for (const event of result.events) {
      const line = describe(event);
      if (line) console.log(`  · ${line}`);
    }
  }

  console.log(`助手：${result.message ?? "(没有文本回复)"}`);
  console.log(`状态：${result.status}`);

  return reportFailures(result.events);
}

const client = new Client({
  host,
  // 自托管部署需要凭据；本地 eve dev 不需要。
  ...(token ? { auth: { bearer: token } } : {}),
});

try {
  const health = await client.health();
  console.log(`已连接 ${host}（workflowId=${health.workflowId}）\n`);
} catch (error) {
  console.error(`无法连接 ${host}：${error.message}`);
  console.error("先运行 `npm run dev:clean` 启动 agent。");
  process.exit(1);
}

const turn = verbose ? streamTurn : collectTurn;
let failed = false;

if (messages.length > 0) {
  const { response } = await client.sessions.create({ message: messages.join(" ") });
  failed = await turn(response);
  process.exit(failed ? 1 : 0);
}

/** 把 stdin 一次性读完，按行返回非空内容。 */
async function readStdinLines() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// 非 TTY（管道、重定向）：先读完 stdin 再逐条发送。
// 边读边等会丢数据——第一次 question 处理期间 readline 就会读到 EOF 并关闭。
if (!process.stdin.isTTY) {
  const lines = await readStdinLines();
  let session = null;

  for (const line of lines) {
    if (session === null) {
      const created = await client.sessions.create({ message: line });
      session = created.session;
      if (await turn(created.response)) failed = true;
    } else if (await turn(await session.send(line))) {
      failed = true;
    }
  }

  process.exit(failed ? 1 : 0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log("输入消息开始对话，直接回车或 Ctrl+C 退出。\n");

let session = null;

for (;;) {
  // Ctrl+D 会让 readline 关闭，此时再调 question() 会抛 ERR_USE_AFTER_CLOSE。
  if (rl.closed) break;

  let input;
  try {
    input = (await rl.question("你：")).trim();
  } catch {
    break;
  }

  if (!input) break;

  if (session === null) {
    const created = await client.sessions.create({ message: input });
    session = created.session;
    if (await turn(created.response)) failed = true;
  } else {
    if (await turn(await session.send(input))) failed = true;
  }
}

rl.close();
process.exit(failed ? 1 : 0);
