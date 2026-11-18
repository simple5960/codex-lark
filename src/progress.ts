export type TaskProgress = {
  step: string;
  plan?: { text: string; completed: boolean }[];
  output?: string;
  outputKind?: 'markdown' | 'text';
};

export interface TaskCard {
  readonly messageId?: string;
  update(markdown: string): void;
  finish(markdown: string): Promise<void>;
}
export type TaskCardFactory = (messageId: string, markdown: string, existingMessageId?: string) => Promise<TaskCard>;

function escape(text: string) { return text.replace(/[\\`*_\[\]<>#]/g, '\\$&'); }
function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function renderProgress(progress: TaskProgress, elapsedMs: number) {
  const sections = [`## ⏳ Codex 正在执行\n\n**当前步骤：** ${escape(progress.step.slice(0, 160))}\n\n**已用时：** ${duration(elapsedMs)} · 可发送 /cancel 取消`];
  if (progress.plan?.length) {
    sections.push('### 任务步骤\n' + progress.plan.slice(0, 12).map(item => `- [${item.completed ? 'x' : ' '}] ${escape(item.text.slice(0, 160))}`).join('\n'));
  }
  if (progress.output) {
    const excerpt = progress.output.slice(-2400);
    if (progress.outputKind === 'text') {
      const runs = excerpt.match(/`+/g) ?? [];
      const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
      sections.push(`### 最近输出\n${fence}\n${excerpt}\n${fence}`);
    } else sections.push(`### 阶段性输出\n${excerpt}`);
  }
  return sections.join('\n\n');
}

export function renderFinal(status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'interrupted', text: string, elapsedMs: number) {
  const labels = { completed: '✅ 任务完成', failed: '❌ 任务失败', cancelled: '⏹️ 任务已取消', timeout: '⏱️ 任务超时', interrupted: '⏸️ 任务已中断' };
  return `## ${labels[status]}\n\n**耗时：** ${duration(elapsedMs)}\n\n${text}`;
}
