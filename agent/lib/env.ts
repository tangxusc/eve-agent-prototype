import { existsSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

/**
 * 读取应用根目录的 .env。eve dev / eve start 都以项目根为工作目录，
 * 所以直接取 process.cwd()/.env。文件不存在时静默跳过，交给运行时环境变量。
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  const file = resolve(process.cwd(), ".env");
  if (!existsSync(file)) return;

  try {
    process.loadEnvFile(file);
  } catch (error) {
    console.warn(`[env] 读取 ${file} 失败，改用进程环境变量`, error);
  }
}

loadEnv();
