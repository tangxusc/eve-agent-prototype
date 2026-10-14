import { defineHook } from "eve/hooks";

import { redis, redisKeys, SESSION_EVENT_TTL_SECONDS } from "../lib/redis";

const MAX_EVENTS_PER_SESSION = 200;

/**
 * 把会话的生命周期事件写进 Redis，形成一条可直接查看的运行轨迹：
 *   redis-cli LRANGE eve-agent:session:<sessionId>:events 0 -1
 *
 * 只订阅关键事件，action.partial 这类高频事件不记。
 */
export default defineHook({
  events: {
    async "session.started"(event, ctx) {
      await append(ctx.session.id, event);
    },
    async "turn.started"(event, ctx) {
      await append(ctx.session.id, event);
    },
    async "turn.completed"(event, ctx) {
      await append(ctx.session.id, event);
    },
    async "turn.failed"(event, ctx) {
      await append(ctx.session.id, event);
    },
    async "session.completed"(event, ctx) {
      await append(ctx.session.id, event);
    },
  },
});

async function append(sessionId: string, event: { type: string; meta: { id: string; at: unknown } }) {
  const client = await redis();
  const key = redisKeys.sessionEvents(sessionId);

  await client.rPush(
    key,
    JSON.stringify({ type: event.type, id: event.meta.id, at: event.meta.at }),
  );
  await client.lTrim(key, -MAX_EVENTS_PER_SESSION, -1);
  await client.expire(key, SESSION_EVENT_TTL_SECONDS);
}
