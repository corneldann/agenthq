import { appendFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

type Message = { role: string; content: string; [key: string]: unknown };

interface SessionEntry {
  timestamp: string;
  message: Message;
}

export function initSessionDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function saveMessage(sessionPath: string, message: Message): void {
  const entry: SessionEntry = {
    timestamp: new Date().toISOString(),
    message,
  };
  appendFileSync(sessionPath, JSON.stringify(entry) + '\n');
}

export async function loadSession(sessionPath: string): Promise<Message[]> {
  const file = Bun.file(sessionPath);
  if (!(await file.exists())) return [];

  const text = await file.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        const entry: SessionEntry = JSON.parse(line);
        return entry.message;
      } catch {
        return null;
      }
    })
    .filter((m): m is Message => m !== null);
}

export function listSessions(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
}

export function newSessionPath(dir: string): string {
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  return join(dir, `${id}.jsonl`);
}
