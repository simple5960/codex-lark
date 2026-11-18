export type TaskPhase = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'interrupted';
export type TaskRecord = {
  id: string;
  ownerKey: string;
  group?: boolean;
  previousTaskId?: string;
  title: string;
  prompt: string;
  phase: TaskPhase;
  createdAt: number;
  updatedAt: number;
  queuedAt: number;
  messageId: string;
  messageIds: string[];
  cardId?: string;
  workspace?: string;
  branch?: string;
  baseCommit?: string;
  threadId?: string;
  lastResult?: string;
};

export const phaseLabels: Record<TaskPhase, string> = {
  queued: '排队中', running: '执行中', completed: '已完成', failed: '失败',
  cancelled: '已取消', timeout: '超时', interrupted: '已中断',
};
