import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

import { redisMemory } from "../lib/redis-memory";

/**
 * 长期记忆槽，存 Redis。
 * 模型看到的工具名会带上槽位前缀：profile__remember、profile__search 等。
 */
export default defineMemory({
  description: "跨会话长期记忆：用户身份与偏好、长期项目设定、稳定约定",
  namespace: "eve-agent-demo-v1",
  provider: redisMemory(),
  scope: byPrincipal,
});
