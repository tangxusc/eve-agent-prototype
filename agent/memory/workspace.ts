import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

import { redisTodos } from "../lib/redis-todo";

/**
 * 待办清单槽，存 Redis。
 * 只提供工具、不自动召回：模型看到的工具名是 workspace__add、workspace__list、
 * workspace__complete、workspace__remove。
 */
export default defineMemory({
  description: "用户的待办清单：要做的事、完成状态",
  namespace: "eve-agent-demo-v1",
  provider: redisTodos(),
  scope: byPrincipal,
});
