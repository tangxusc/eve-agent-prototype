import type { ModelMessage } from "ai";

/** 把一条模型消息压成纯文本，用于检索、记忆和审计日志。 */
export function messageText(message: ModelMessage): string {
  const content: unknown = message.content;

  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part && part.type === "text") {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

export function messagesText(messages: readonly ModelMessage[]): string {
  return messages.map(messageText).filter(Boolean).join("\n");
}

/** 取最后一条 assistant 消息的文本，即本轮对用户的回复。 */
export function lastAssistantText(messages: readonly ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "assistant") {
      const text = messageText(message);
      if (text) return text;
    }
  }
  return "";
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
