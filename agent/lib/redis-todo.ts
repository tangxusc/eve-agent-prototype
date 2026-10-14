import { defineMemoryProvider } from "eve/memory";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { addTodo, completeTodo, listTodos, removeTodo } from "./todo-store";

/**
 * 待办清单的 provider。
 *
 * 待办是结构化状态，不需要每轮自动召回，所以只实现 tools，不实现 recall/capture
 * （recall 必须存在，返回 null 表示不注入任何内容）。
 *
 * 和长期记忆共用同一套分区机制：全部读写都用 eve 锁定的 ctx.memory.scope.key。
 */
export function redisTodos() {
  return defineMemoryProvider({
    recall: {
      async "turn.started"() {
        return null;
      },
    },

    async tools(ctx) {
      const scope = ctx.memory.scope.key;

      return {
        add: defineTool({
          description:
            "往待办清单里加一条待办。用户说“记一下要做某事”“加入待办”“提醒我做某事”时使用。",
          inputSchema: z.object({
            text: z.string().min(1).describe("待办内容，写清楚做什么"),
          }),
          label: {
            start: ({ text }) => `添加待办：${text}`,
          },
          async execute({ text }) {
            return { added: true, todo: await addTodo(scope, text) };
          },
        }),

        list: defineTool({
          description: "列出待办清单。默认只列未完成的。",
          inputSchema: z.object({
            includeDone: z.boolean().optional().describe("是否包含已完成的待办，默认 false"),
          }),
          async execute({ includeDone }) {
            const all = await listTodos(scope);
            const todos = includeDone ? all : all.filter((todo) => !todo.done);

            return {
              count: todos.length,
              open: all.filter((todo) => !todo.done).length,
              done: all.filter((todo) => todo.done).length,
              todos,
            };
          },
        }),

        complete: defineTool({
          description: "把一条待办标记为已完成。需要先用 list 拿到待办 id。",
          inputSchema: z.object({
            id: z.string().min(1).describe("待办 id，来自 list 的结果"),
          }),
          async execute({ id }) {
            const todo = await completeTodo(scope, id);
            if (todo === null) {
              throw new Error(`没有找到待办 ${id}。先用 list 确认 id。`);
            }
            return { completed: true, todo };
          },
        }),

        remove: defineTool({
          description: "彻底删除一条待办（不是标记完成）。",
          inputSchema: z.object({
            id: z.string().min(1).describe("待办 id，来自 list 的结果"),
          }),
          async execute({ id }) {
            return { removed: await removeTodo(scope, id), id };
          },
        }),
      };
    },
  });
}
