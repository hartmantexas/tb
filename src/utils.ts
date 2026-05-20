import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createServer } from "net";

export const TB_DIR = join(homedir(), ".tb");
export const DAEMON_SOCK = join(TB_DIR, "daemon.sock");
export const DAEMON_PID_FILE = join(TB_DIR, "daemon.pid");
export const ENGINES_DIR = join(TB_DIR, "engines");
export const CONFIG_FILE = join(TB_DIR, "config.json");

export function ensureTBDir(): string {
  for (const dir of [TB_DIR, ENGINES_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return TB_DIR;
}

export function getDaemonPid(): number | null {
  try {
    const pid = parseInt(readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function writeDaemonPid(pid: number): void {
  ensureTBDir();
  writeFileSync(DAEMON_PID_FILE, String(pid));
}

export function removeDaemonPid(): void {
  try {
    unlinkSync(DAEMON_PID_FILE);
  } catch {}
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function findPort(startFrom = 9800): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Could not find port")));
      }
    });
    srv.on("error", reject);
  });
}

export async function waitForPort(
  port: number,
  host = "127.0.0.1",
  timeout = 15000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://${host}:${port}/json/version`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for port ${port}`);
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
