import { redis, redisKeys } from "./redis";

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
  completedAt: string | null;
}

function newId(): string {
  return `todo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export async function addTodo(scope: string, text: string): Promise<Todo> {
  const client = await redis();
  const todo: Todo = {
    id: newId(),
    text,
    done: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  await client.hSet(redisKeys.todos(scope), todo.id, JSON.stringify(todo));
  return todo;
}

export async function listTodos(scope: string): Promise<Todo[]> {
  const client = await redis();
  const raw = await client.hGetAll(redisKeys.todos(scope));
  return Object.values(raw)
    .map((value) => JSON.parse(value) as Todo)
    .sort((a, b) => Number(a.done) - Number(b.done) || a.createdAt.localeCompare(b.createdAt));
}

export async function completeTodo(scope: string, id: string): Promise<Todo | null> {
  const client = await redis();
  const raw = await client.hGet(redisKeys.todos(scope), id);
  if (raw === null) return null;

  const todo = JSON.parse(raw) as Todo;
  const updated: Todo = { ...todo, done: true, completedAt: new Date().toISOString() };
  await client.hSet(redisKeys.todos(scope), id, JSON.stringify(updated));
  return updated;
}

export async function removeTodo(scope: string, id: string): Promise<boolean> {
  const client = await redis();
  return (await client.hDel(redisKeys.todos(scope), id)) > 0;
}
