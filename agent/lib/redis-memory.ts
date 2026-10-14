import { defineMemoryProvider } from "eve/memory";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { lastAssistantText, messagesText, truncate } from "./messages";
import {
  deleteFact,
  listFacts,
  listTurnRecords,
  saveFact,
  saveTurnRecord,
  searchFacts,
} from "./memory-store";

const RECALL_LIMIT = 8;
const STORED_TEXT_LIMIT = 2000;

/**
 * Redis 支撑的长期记忆 provider。
 *
 * - recall：每轮开始前按用户输入检索已存事实，作为 user 消息注入上下文
 * - capture：每轮结束后把这一轮的用户输入与助手回复写入 Redis（按 operationId 幂等）
 * - tools：remember / search / forget / list / history，名字会带上槽位前缀
 *
 * 所有读写都用 eve 锁定的 ctx.memory.scope.key 分区，
 * 模型无法把它指向别的用户。
 */
export function redisMemory() {
  return defineMemoryProvider({
    recall: {
      async "turn.started"(ctx) {
        const query = messagesText(ctx.turn.input);
        const facts = await searchFacts(ctx.memory.scope.key, query, RECALL_LIMIT);
        if (facts.length === 0) return null;

        return {
          messages: facts.map((fact) => ({ id: fact.id, content: fact.text })),
        };
      },
    },

    capture: {
      async "turn.completed"(ctx) {
        const user = truncate(messagesText(ctx.turn.input), STORED_TEXT_LIMIT);
        const assistant = truncate(lastAssistantText(ctx.messages), STORED_TEXT_LIMIT);

        if (!user && !assistant) return;

        await saveTurnRecord(ctx.memory.scope.key, {
          operationId: ctx.operationId,
          turnId: ctx.turn.id,
          sequence: ctx.turn.sequence,
          at: new Date().toISOString(),
          user,
          assistant,
        });
      },
    },

    async tools(ctx) {
      const scope = ctx.memory.scope.key;

      return {
        remember: defineTool({
          description:
            "把一条长期事实写入长期记忆。用于跨会话仍然成立的信息：用户身份与偏好、长期项目设定、稳定的约定。不要写一次性内容或本轮对话细节。",
          inputSchema: z.object({
            text: z.string().min(1).describe("要记住的事实，一句话说清楚，包含主语"),
            id: z
              .string()
              .optional()
              .describe("可选稳定标识。传入同一个 id 会覆盖旧值，用于更新而非追加"),
          }),
          async execute({ text, id }) {
            const fact = await saveFact(scope, text, id);
            return { saved: true, id: fact.id, text: fact.text, createdAt: fact.createdAt };
          },
        }),

        search: defineTool({
          description: "在长期记忆里按关键词检索事实。不确定记住了什么时先用它查一遍。",
          inputSchema: z.object({
            query: z.string().min(1).describe("关键词，可以是多个词"),
            limit: z.number().int().min(1).max(20).optional().describe("返回条数上限，默认 8"),
          }),
          async execute({ query, limit }) {
            const facts = await searchFacts(scope, query, limit ?? RECALL_LIMIT);
            return { count: facts.length, facts };
          },
        }),

        forget: defineTool({
          description: "按 id 从长期记忆里删除一条事实。用户要求忘记某事时使用。",
          inputSchema: z.object({
            id: z.string().min(1).describe("事实 id，来自 list 或 search 的结果"),
          }),
          async execute({ id }) {
            return { deleted: await deleteFact(scope, id), id };
          },
        }),

        list: defineTool({
          description: "列出长期记忆里的全部事实及其 id。",
          inputSchema: z.object({}),
          async execute() {
            const facts = await listFacts(scope);
            return { count: facts.length, facts };
          },
        }),

        history: defineTool({
          description: "读取存在 Redis 里的历史对话记录。用户问“之前聊过什么”时用它回答。",
          inputSchema: z.object({
            limit: z.number().int().min(1).max(50).optional().describe("返回最近几轮，默认 5"),
          }),
          async execute({ limit }) {
            const records = await listTurnRecords(scope, limit ?? 5);
            return { count: records.length, records };
          },
        }),
      };
    },
  });
}
