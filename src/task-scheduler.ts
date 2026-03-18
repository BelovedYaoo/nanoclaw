import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, TIMEZONE } from './config.js';
import {
  AgentRuntimeOutput,
  writeTasksSnapshot,
} from './agent-runtime.js';
import {
  getAllTasks,
  getDueTasks,
  getNextScheduledTask,
  getTaskById,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { runHostAgent } from './host-agent-runner.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { ConversationId, MessageTarget, RegisteredConversation, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  resolveTarget: (target: string, conversationId?: ConversationId) => MessageTarget;
  registeredGroups: () => Record<string, RegisteredConversation>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    target: MessageTarget,
    proc: ChildProcess,
    processName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (target: MessageTarget, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder, conversationId: task.conversation_id },
    'Running scheduled task',
  );

  const target = deps.resolveTarget(task.chat_jid, task.conversation_id);
  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    return;
  }

  // Update tasks snapshot for host agent to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the host agent promptly.
  // Tasks are single-turn — no need to keep the query loop alive for long.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task host agent after result');
      deps.queue.closeStdin(target.chatJid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runHostAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: target.chatJid,
        conversationId: target.conversationId,
        target,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
      },
      (proc, processName) =>
        deps.onProcess(target, proc, processName, task.group_folder),
      async (streamedOutput: AgentRuntimeOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user（sendMessage 内部负责格式化）
          await deps.sendMessage(target, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(target.chatJid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
  wakeScheduler();
}

const SCHEDULER_MIN_DELAY_MS = 1000;
const SCHEDULER_MAX_DELAY_MS = 60000;

let schedulerRunning = false;
let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let schedulerTickInFlight = false;
let schedulerWakeRequested = false;
let schedulerDeps: SchedulerDependencies | null = null;

function clearSchedulerTimer(): void {
  if (!schedulerTimer) {
    return;
  }
  clearTimeout(schedulerTimer);
  schedulerTimer = null;
}

function scheduleNextWake(): void {
  if (!schedulerDeps) {
    return;
  }

  clearSchedulerTimer();
  const nextTask = getNextScheduledTask();
  if (!nextTask?.next_run) {
    return;
  }

  const nextRunTime = new Date(nextTask.next_run).getTime();
  if (!Number.isFinite(nextRunTime)) {
    logger.warn({ taskId: nextTask.id, nextRun: nextTask.next_run }, 'Invalid next_run on scheduled task');
    schedulerTimer = setTimeout(() => {
      void processSchedulerTick();
    }, SCHEDULER_MIN_DELAY_MS);
    return;
  }

  const delayMs = Math.min(
    SCHEDULER_MAX_DELAY_MS,
    Math.max(SCHEDULER_MIN_DELAY_MS, nextRunTime - Date.now()),
  );
  schedulerTimer = setTimeout(() => {
    void processSchedulerTick();
  }, delayMs);
}

async function processSchedulerTick(): Promise<void> {
  if (!schedulerDeps) {
    return;
  }
  if (schedulerTickInFlight) {
    schedulerWakeRequested = true;
    return;
  }

  schedulerTickInFlight = true;
  clearSchedulerTimer();
  try {
    const dueTasks = getDueTasks();
    if (dueTasks.length > 0) {
      logger.info({ count: dueTasks.length }, 'Found due tasks');
    }

    for (const task of dueTasks) {
      const currentTask = getTaskById(task.id);
      if (!currentTask || currentTask.status !== 'active') {
        continue;
      }

      schedulerDeps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
        runTask(currentTask, schedulerDeps!),
      );
    }
  } catch (err) {
    logger.error({ err }, 'Error in scheduler loop');
  } finally {
    schedulerTickInFlight = false;
    if (schedulerWakeRequested) {
      schedulerWakeRequested = false;
      queueMicrotask(() => {
        void processSchedulerTick();
      });
      return;
    }
    scheduleNextWake();
  }
}

export function wakeScheduler(): void {
  if (!schedulerRunning || !schedulerDeps) {
    return;
  }
  clearSchedulerTimer();
  queueMicrotask(() => {
    void processSchedulerTick();
  });
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  schedulerDeps = deps;
  logger.info('Scheduler loop started');
  void processSchedulerTick();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  clearSchedulerTimer();
  schedulerRunning = false;
  schedulerTimer = null;
  schedulerTickInFlight = false;
  schedulerWakeRequested = false;
  schedulerDeps = null;
}
