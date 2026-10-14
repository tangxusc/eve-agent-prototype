import { redis, redisKeys } from "./redis";

export interface Fact {
  id: string;
  text: string;
  createdAt: string;
}

export interface TurnRecord {
  operationId: string;
  turnId: string;
  sequence: number;
  at: string;
  user: string;
  assistant: string;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 写入一条长期事实。传入相同 id 会覆盖旧值，便于模型更新同一条记忆。 */
export async function saveFact(scope: string, text: string, id?: string): Promise<Fact> {
  const client = await redis();
  const fact: Fact = {
    id: id ?? newId("fact"),
    text,
    createdAt: new Date().toISOString(),
  };
  await client.hSet(redisKeys.facts(scope), fact.id, JSON.stringify(fact));
  return fact;
}

export async function listFacts(scope: string): Promise<Fact[]> {
  const client = await redis();
  const raw = await client.hGetAll(redisKeys.facts(scope));
  return Object.values(raw)
    .map((value) => JSON.parse(value) as Fact)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deleteFact(scope: string, id: string): Promise<boolean> {
  const client = await redis();
  return (await client.hDel(redisKeys.facts(scope), id)) > 0;
}

export async function countFacts(scope: string): Promise<number> {
  const client = await redis();
  return client.hLen(redisKeys.facts(scope));
}

/**
 * 按关键词检索事实。没有向量库，用词/字/二元组重叠打分：
 * 英文按词，中文同时收单字（权重 1）和二元组（权重 2）。
 * 只收二元组时，「我平时喝什么」召不回「我喜欢喝美式」——两组词没有交集。
 */
export async function searchFacts(scope: string, query: string, limit: number): Promise<Fact[]> {
  const facts = await listFacts(scope);
  if (facts.length === 0) return [];

  const terms = tokenize(query);
  if (terms.length === 0) return facts.slice(-limit);

  return facts
    .map((fact) => ({ fact, score: scoreText(fact.text, terms) }))
    // 至少命中一个二元组，或两个不同单字。低于阈值多半是「我」「的」这类噪声命中。
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || b.fact.createdAt.localeCompare(a.fact.createdAt))
    .slice(0, limit)
    .map((entry) => entry.fact);
}

/** 写入一轮对话记录。field 用 operationId，重复执行不会产生重复记录。 */
export async function saveTurnRecord(scope: string, record: TurnRecord): Promise<void> {
  const client = await redis();
  await client.hSet(redisKeys.turns(scope), record.operationId, JSON.stringify(record));
}

export async function listTurnRecords(scope: string, limit: number): Promise<TurnRecord[]> {
  const client = await redis();
  const raw = await client.hGetAll(redisKeys.turns(scope));
  return Object.values(raw)
    .map((value) => JSON.parse(value) as TurnRecord)
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-limit);
}

export async function countTurnRecords(scope: string): Promise<number> {
  const client = await redis();
  return client.hLen(redisKeys.turns(scope));
}

/** 命中阈值：一个二元组，或两个不同单字。 */
const MIN_SCORE = 2;

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = new Set<string>(lower.match(/[a-z0-9_]+/g) ?? []);

  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (const char of run) tokens.add(char);
    for (let i = 0; i + 2 <= run.length; i += 1) {
      tokens.add(run.slice(i, i + 2));
    }
  }

  return [...tokens];
}

/** 单字权重 1，二元组权重 2，英文按词长。 */
function scoreText(text: string, terms: readonly string[]): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += term.length;
  }
  return score;
}
