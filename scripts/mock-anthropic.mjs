/**
 * 本地 mock Anthropic Messages API。用于在没有可用 API Key 时验证 eve 的完整回路：
 * 会话 -> 模型 -> 工具调用 -> Redis 写入 -> 回复。
 *
 * 它按用户输入里的关键词决定调用哪个工具，然后给出一段固定格式的文本，
 * 不产生任何真实模型调用。
 *
 *   node scripts/mock-anthropic.mjs
 *   DEEPSEEK_BASE_URL=http://127.0.0.1:8787/v1 npm run dev:headless
 */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8787);
const MODEL = process.env.MOCK_MODEL ?? "deepseek-v4-flash";

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function flatten(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function analyze(body) {
  const messages = body.messages ?? [];
  const toolNames = (body.tools ?? []).map((tool) => tool.name);

  let hasToolResult = false;
  let lastUserText = "";
  for (const message of messages) {
    if (Array.isArray(message.content) && message.content.some((p) => p?.type === "tool_result")) {
      hasToolResult = true;
    }
    if (message.role === "user" && !Array.isArray(message.content)) {
      lastUserText = flatten(message.content);
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      const text = flatten(message.content);
      if (text) lastUserText = text;
    }
  }

  return { messages, toolNames, hasToolResult, lastUserText };
}

function decide(body) {
  const { toolNames, hasToolResult, lastUserText } = analyze(body);

  if (!hasToolResult) {
    if (lastUserText.includes("天气") && toolNames.includes("get_weather")) {
      return { kind: "tool", name: "get_weather", input: { city: "北京" } };
    }
    if (lastUserText.includes("待办") && toolNames.includes("workspace__add")) {
      return {
        kind: "tool",
        name: "workspace__add",
        input: { text: "把下周评审加进待办" },
      };
    }
    if (lastUserText.includes("记住") && toolNames.includes("profile__remember")) {
      return {
        kind: "tool",
        name: "profile__remember",
        input: { text: lastUserText.replace(/^记住[:：]?/, "").trim(), id: "mock-fact" },
      };
    }
    if (toolNames.includes("redis_overview")) {
      return { kind: "tool", name: "redis_overview", input: {} };
    }
  }

  return {
    kind: "text",
    text:
      `[mock 模型] 已收到你的输入：「${lastUserText.slice(0, 60)}」。` +
      `本轮${hasToolResult ? "调用过工具并拿到了结果" : "没有调用工具"}。` +
      `可用工具数 ${toolNames.length}。`,
  };
}

function writeStream(res, plan) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const messageId = `msg_mock_${Date.now().toString(36)}`;

  sse(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 128, output_tokens: 1 },
    },
  });

  if (plan.kind === "tool") {
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: `toolu_${messageId}`, name: plan.name, input: {} },
    });
    sse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(plan.input) },
    });
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  } else {
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    sse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: plan.text },
    });
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  }

  sse(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: plan.kind === "tool" ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage: { output_tokens: 32 },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function writeJson(res, plan) {
  const content =
    plan.kind === "tool"
      ? [{ type: "tool_use", id: `toolu_${Date.now().toString(36)}`, name: plan.name, input: plan.input }]
      : [{ type: "text", text: plan.text }];

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: `msg_mock_${Date.now().toString(36)}`,
      type: "message",
      role: "assistant",
      model: MODEL,
      content,
      stop_reason: plan.kind === "tool" ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 128, output_tokens: 32 },
    }),
  );
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");

    if (req.url?.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 128 }));
      return;
    }

    if (!req.url?.includes("/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "not_found_error", message: req.url } }));
      return;
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "bad json" } }));
      return;
    }

    const plan = decide(body);

    const userTexts = (body.messages ?? [])
      .filter((message) => message.role === "user")
      .map((message) => flatten(message.content))
      .filter((text) => text.length > 0);
    const systemChars = typeof body.system === "string" ? body.system.length : 0;
    console.log(
      `[mock] ${plan.kind === "tool" ? `tool_use ${plan.name}` : "text"} ` +
        `(stream=${body.stream === true}, tools=${(body.tools ?? []).length}, systemChars=${systemChars})`,
    );
    console.log(`[mock] 收到的 user 文本 ${userTexts.length} 条：`);
    for (const text of userTexts) console.log(`        · ${text.slice(0, 90)}`);

    if (body.stream === true) writeStream(res, plan);
    else writeJson(res, plan);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock] Anthropic Messages API 模拟端点已启动: http://127.0.0.1:${PORT}/v1`);
});
