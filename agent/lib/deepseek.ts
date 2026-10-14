import "./env";

import { createAnthropic } from "@ai-sdk/anthropic";
import { wrapLanguageModel, type LanguageModel } from "ai";

/**
 * DeepSeek 的 Anthropic 兼容入口是 https://api.deepseek.com/anthropic，
 * 而 AI SDK 的 Anthropic provider 把 baseURL 当成 ".../v1" 用
 * （默认值 https://api.anthropic.com/v1）。缺 /v1 就补上，
 * 免得拼出 /anthropic/messages 这种 404 路径。
 */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

const baseURL = normalizeBaseUrl(
  process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/anthropic/v1",
);

const defaultModelId = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";

/**
 * AI SDK 不认识 DeepSeek 的模型名，会把 maxOutputTokens 压到 4096 并打警告：
 *   The model "deepseek-v4-flash" is unknown. The max output tokens have been limited to 4096.
 * 显式传值可以绕开。DeepSeek 侧上限是 393216，这里默认给一个够用又不至于失控的值。
 */
const maxOutputTokens = Number(process.env.DEEPSEEK_MAX_OUTPUT_TOKENS ?? 16_384);

/** 自定义模型不在 AI Gateway 目录里，需要显式声明上下文窗口。 */
const contextWindowTokens = Number(process.env.DEEPSEEK_CONTEXT_WINDOW ?? 1_048_576);

const provider = createAnthropic({
  name: "deepseek",
  baseURL,
  apiKey: process.env.DEEPSEEK_API_KEY,
});

/** 返回一个直连 DeepSeek 的 LanguageModel，供 defineAgent({ model }) 使用。 */
export function deepseek(modelId: string = defaultModelId): LanguageModel {
  return wrapLanguageModel({
    model: provider(modelId),
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        // 只在调用方没指定时兜底，不覆盖 eve 自己算出的值。
        maxOutputTokens: params.maxOutputTokens ?? maxOutputTokens,
      }),
    },
  });
}

export const deepseekInfo = {
  baseURL,
  modelId: defaultModelId,
  contextWindowTokens,
  maxOutputTokens,
};
