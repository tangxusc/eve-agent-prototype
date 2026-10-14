#!/usr/bin/env node
/**
 * 启动前自检：配置、Redis、模型凭据。
 *
 *   npm run doctor
 *
 * 三项都过再启动 agent，避免 401 之类的错误混在会话日志里。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { createClient } from "redis";

const root = process.cwd();
const envFile = resolve(root, ".env");

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
  console.log(`✓ 已读取 ${envFile}`);
} else {
  console.log(`! 没有 ${envFile}，改用进程环境变量（参考 .env.example）`);
}

const baseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/anthropic/v1";
const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const apiKey = process.env.DEEPSEEK_API_KEY;
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const failures = [];

// 1) 模型凭据
if (!apiKey) {
  failures.push("DEEPSEEK_API_KEY 未设置");
  console.log("✗ 模型凭据：DEEPSEEK_API_KEY 未设置");
} else {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/messages`;
  process.stdout.write(`· 模型凭据：POST ${endpoint} … `);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      }),
    });

    if (response.ok) {
      console.log(`✓ 可用（HTTP ${response.status}，model=${model}）`);
    } else {
      const body = (await response.text()).slice(0, 200);
      console.log(`✗ HTTP ${response.status}`);
      console.log(`    ${body}`);
      if (response.status === 401) {
        failures.push("API key 被拒绝（401）");
        console.log("    这个 key 无效。去 platform.deepseek.com 取一个新的，写进 .env 的 DEEPSEEK_API_KEY。");
        console.log("    或者先用 mock 跑通链路：");
        console.log("      npm run mock:model");
        console.log("      DEEPSEEK_BASE_URL=http://127.0.0.1:8787/v1 npm run dev:headless");
      } else if (response.status === 404) {
        failures.push("端点 404");
        console.log("    路径不对。DEEPSEEK_BASE_URL 末尾要带 /v1，例如 https://api.deepseek.com/anthropic/v1");
      }
    }
  } catch (error) {
    console.log(`✗ 请求失败：${error.message}`);
    failures.push("模型端点不可达");
  }
}

// 2) Redis
const client = createClient({ url: redisUrl });
client.on("error", () => {});

try {
  await client.connect();
  const pong = await client.ping();
  const keys = await client.keys(`${process.env.REDIS_KEY_PREFIX ?? "eve-agent"}:*`);
  console.log(`✓ Redis：${redisUrl} 响应 ${pong}，现有 ${keys.length} 个键`);
  await client.quit();
} catch (error) {
  console.log(`✗ Redis：连不上 ${redisUrl} —— ${error.message}`);
  console.log("    先起容器：npm run redis:up");
  failures.push("Redis 不可达");
}

// 3) 生产 / 自托管路径
const authMode = process.env.EVE_AUTH_MODE;
const authToken = process.env.EVE_AUTH_TOKEN;
const hasBuild = existsSync(resolve(root, ".output"));

if (authMode === "none") {
  console.log("! EVE_AUTH_MODE=none：生产环境不鉴权，确认流量可以公开再这么配");
} else if (authToken) {
  console.log(`✓ 自托管鉴权：已配 EVE_AUTH_TOKEN（${authToken.length} 字符）`);
} else {
  console.log("! 未配 EVE_AUTH_TOKEN：eve dev 不受影响，但 eve start 会拒绝所有会话请求（401）");
}

console.log(hasBuild ? "✓ 已有生产构建 .output/" : "· 还没有 .output/，需要时跑 npm run build");

// 4) 沙箱提醒
if (process.env.NODE_OPTIONS?.includes("node-language-shim")) {
  console.log("! 检测到 WorkBuddy 注入的 NODE_OPTIONS shim");
  console.log("    eve 的本地 Workflow world 解锁会失败，启动 agent 必须用 npm run dev:clean");
}

console.log();
if (failures.length === 0) {
  console.log("全部通过。启动：npm run dev:clean");
  process.exit(0);
}

console.log(`有 ${failures.length} 项没过：${failures.join("；")}`);
process.exit(1);
