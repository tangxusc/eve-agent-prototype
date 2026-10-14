import "./env";

import { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const prefix = process.env.REDIS_KEY_PREFIX ?? "eve-agent";

let clientPromise: Promise<RedisClient> | null = null;

/**
 * 惰性建立并复用同一条 Redis 连接。
 * 连接失败时不缓存 promise，下一次调用会重新尝试。
 */
export function redis(): Promise<RedisClient> {
  if (clientPromise === null) {
    clientPromise = (async () => {
      const client = createClient({ url });
      client.on("error", (error: unknown) => console.error("[redis] 连接错误", error));
      await client.connect();
      console.log(`[redis] 已连接 ${url}`);
      return client;
    })().catch((error: unknown) => {
      clientPromise = null;
      throw error;
    });
  }

  return clientPromise;
}

/** 统一键命名，方便直接用 redis-cli 查看。 */
export const redisKeys = {
  prefix,
  /** 长期记忆：hash，field = 事实 id */
  facts: (scope: string) => `${prefix}:facts:${scope}`,
  /** 会话历史：hash，field = operationId（天然幂等） */
  turns: (scope: string) => `${prefix}:turns:${scope}`,
  /** 待办：hash，field = todo id */
  todos: (scope: string) => `${prefix}:todos:${scope}`,
  /** 运行事件流：list，按 session 记录 */
  sessionEvents: (sessionId: string) => `${prefix}:session:${sessionId}:events`,
};

/** 事件流保留时长，避免 Redis 无限增长。 */
export const SESSION_EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;
