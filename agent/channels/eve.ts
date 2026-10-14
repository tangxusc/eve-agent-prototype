import { timingSafeEqual } from "node:crypto";

import { type AuthFn, localDev, none, placeholderAuth, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

/**
 * 用 EVE_AUTH_TOKEN 做 Bearer 校验。
 * 每次请求读环境变量，不依赖构建期的值。
 */
function sharedToken(): AuthFn<Request> {
  return async (request) => {
    const expected = process.env.EVE_AUTH_TOKEN;
    if (!expected) return null;

    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match === null) return null;

    const given = Buffer.from(match[1]);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

    return {
      attributes: {},
      authenticator: "shared-token",
      principalId: "eve-demo",
      principalType: "user",
    };
  };
}

const auth: AuthFn<Request>[] = [
  // 让 eve TUI 和同团队的 Vercel 部署能访问已部署的 agent。
  vercelOidc(),
  // 本地开发（eve dev）放行，生产环境自动忽略。
  localDev(),
];

if (process.env.EVE_AUTH_MODE === "none") {
  // 公开 demo：完全不鉴权。只在确认流量可以公开时用。
  auth.push(none());
} else {
  // 自托管：先试 Bearer token，没配 EVE_AUTH_TOKEN 就落到 placeholderAuth()，
  // 按 eve 的默认姿势拒绝所有生产请求。
  auth.push(sharedToken(), placeholderAuth());
}

/**
 * 同一 session 收到新消息时怎么处理：
 * - "steer"（eve 默认）：打断进行中的 turn，把新消息并进当前 turn。用户只看到一条回复。
 *   适合「刚才说错了，改成……」这类纠偏。
 * - "queue"：排队，每条消息独立成一个 turn，逐条回复。适合需要逐条确认的场景。
 * 实测差异见 README「同一 session 的并发行为」。
 */
const turnPolicy = process.env.EVE_TURN_POLICY === "queue" ? "queue" : "steer";

export default eveChannel({
  auth,
  // 允许浏览器直接调 /eve/v1，方便本地前端联调。
  cors: true,
  turnPolicy,
});
