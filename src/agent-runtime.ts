import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from './group-folder.js';

export interface AgentRuntimeInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  conversationId?: string;
  target?: {
    chatJid: string;
    conversationId: string;
    channel: string;
    externalId: string;
    peerKind: 'group' | 'user' | 'system' | 'legacy';
    isGroup: boolean;
  };
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface AgentRuntimeOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((task) => task.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];
  const groupsFile = path.join(groupIpcDir, 'available_groups.json');

  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        registered: Array.from(registeredJids),
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
