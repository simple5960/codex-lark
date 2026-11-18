import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type Data = { threads: Record<string, string>; seen: Record<string, number> };
export class State {
  data: Data = { threads: {}, seen: {} };
  private writes = Promise.resolve();
  readonly path: string;
  constructor(path: string) { this.path = path; }
  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Data;
      if (!parsed.threads || !parsed.seen || typeof parsed.threads !== 'object' || typeof parsed.seen !== 'object') throw new Error('会话状态文件损坏');
      this.data = parsed;
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
