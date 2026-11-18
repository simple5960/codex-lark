import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TaskRecord } from './tasks.ts';

type Data = { threads: Record<string, string>; seen: Record<string, number>; tasks: Record<string, TaskRecord>; current: Record<string, string> };
export class State {
  data: Data = { threads: {}, seen: {}, tasks: {}, current: {} };
  private writes = Promise.resolve();
  readonly path: string;
  constructor(path: string) { this.path = path; }
  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Data;
      const isMap = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
      if (!isMap(parsed.threads) || !isMap(parsed.seen) || (parsed.tasks !== undefined && !isMap(parsed.tasks)) || (parsed.current !== undefined && !isMap(parsed.current))) throw new Error('会话状态文件损坏');
      this.data = { ...parsed, tasks: parsed.tasks ?? {}, current: parsed.current ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  async claim(id: string) {
    if (Object.hasOwn(this.data.seen, id)) return false;
    this.data.seen[id] = Date.now();
    for (const [key, at] of Object.entries(this.data.seen)) {
      if (at < Date.now() - 86_400_000) delete this.data.seen[key];
    }
    await this.save();
    return true;
  }
  save() {
    const content = JSON.stringify(this.data);
    const next = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(this.path + '.tmp', content, { mode: 0o600 });
      await rename(this.path + '.tmp', this.path);
    });
    this.writes = next.catch(() => {});
    return next;
  }
}
