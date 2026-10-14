import { defineAgent } from "eve";

import { deepseek, deepseekInfo } from "./lib/deepseek";

export default defineAgent({
  // 直连 DeepSeek 的 Anthropic 兼容入口，不走 AI Gateway。
  model: deepseek(),
  // 自定义模型不在 Gateway 目录里，上下文窗口要显式声明。
  modelContextWindowTokens: deepseekInfo.contextWindowTokens,
});
