import { defineTool } from "eve/tools";
import { z } from "zod";

import { redis, redisKeys } from "../lib/redis";

const MAX_KEYS = 200;

interface KeyInfo {
  key: string;
  type: string;
  length: number | null;
  ttlSeconds: number;
}

/**
 * 观测用工具：把 Redis 里的状态如实读出来。
 *
 * 只做扫描和统计，不假设分区键怎么算——所有按用户分区的键都由 eve 的
 * memory 槽生成，工具侧无从复现，所以这里直接从 Redis 读事实。
 */
export default defineTool({
  description:
    "查看当前状态在 Redis 里的存储情况：键名、类型、条数、过期时间。用户问“你记了什么”“状态存在哪”时用它回答。",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const client = await redis();
    const keys: KeyInfo[] = [];

    // scanIterator 每次 yield 一批键（string[]），不是单个键。
    outer: for await (const batch of client.scanIterator({
      MATCH: `${redisKeys.prefix}:*`,
      COUNT: 200,
    })) {
      for (const raw of batch) {
        if (keys.length >= MAX_KEYS) break outer;

        const key = String(raw);
        const type = await client.type(key);
        const [ttlSeconds, length] = await Promise.all([
          client.ttl(key),
          keyLength(client, key, type),
        ]);

        keys.push({ key, type, length, ttlSeconds });
      }
    }

    keys.sort((a, b) => a.key.localeCompare(b.key));

    return {
      sessionId: ctx.session.id,
      prefix: redisKeys.prefix,
      keyCount: keys.length,
      truncated: keys.length >= MAX_KEYS,
      keys,
    };
  },
});

async function keyLength(
  client: Awaited<ReturnType<typeof redis>>,
  key: string,
  type: string,
): Promise<number | null> {
  switch (type) {
    case "hash":
      return client.hLen(key);
    case "list":
      return client.lLen(key);
    case "set":
      return client.sCard(key);
    case "zset":
      return client.zCard(key);
    case "string":
      return client.strLen(key);
    default:
      return null;
  }
}
