import fs from 'fs';
import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

const ipcDir = process.env.NANOCLAW_IPC_DIR ?? '';
const messagesDir = path.join(ipcDir, 'messages');
const tasksDir = path.join(ipcDir, 'tasks');
const chatJid = process.env.NANOCLAW_CHAT_JID ?? '';
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER ?? '';
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: Record<string, unknown>): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filePath = path.join(dir, filename);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  'Send a message to the current chat immediately.',
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Optional sender identity'),
  },
  async (args) => {
    writeIpcFile(messagesDir, {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  'Schedule a recurring or one-time task for the current chat, or for another registered chat when running in the main chat.',
  {
    prompt: z.string().describe('Task prompt'),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string(),
    context_mode: z.enum(['group', 'isolated']).default('group'),
    target_chat_jid: z.string().optional(),
    target_group_jid: z.string().optional().describe('兼容旧参数，请优先使用 target_chat_jid'),
  },
  async (args) => {
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const milliseconds = parseInt(args.schedule_value, 10);
      if (Number.isNaN(milliseconds) || milliseconds <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    } else {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix: "${args.schedule_value}".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (Number.isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(tasksDir, {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode,
      targetJid:
        isMain && (args.target_chat_jid || args.target_group_jid)
          ? (args.target_chat_jid || args.target_group_jid)
          : chatJid,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{
        type: 'text' as const,
        text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
      }],
    };
  },
);

server.tool(
  'list_tasks',
  'List all scheduled tasks visible to this chat.',
  {},
  async () => {
    const tasksFile = path.join(ipcDir, 'current_tasks.json');
    if (!fs.existsSync(tasksFile)) {
      return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(tasksFile, 'utf-8')) as Array<{
        id: string;
        groupFolder: string;
        prompt: string;
        schedule_type: string;
        schedule_value: string;
        status: string;
        next_run: string | null;
      }>;

      const visibleTasks = isMain
        ? parsed
        : parsed.filter((task) => task.groupFolder === groupFolder);

      if (visibleTasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const text = visibleTasks
        .map((task) => `- [${task.id}] ${task.prompt.slice(0, 50)}... (${task.schedule_type}: ${task.schedule_value}) - ${task.status}, next: ${task.next_run || 'N/A'}`)
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${text}` }] };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading tasks: ${error instanceof Error ? error.message : String(error)}`,
        }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task.',
  { task_id: z.string() },
  async (args) => {
    writeIpcFile(tasksDir, {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string() },
  async (args) => {
    writeIpcFile(tasksDir, {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel a scheduled task.',
  { task_id: z.string() },
  async (args) => {
    writeIpcFile(tasksDir, {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task.',
  {
    task_id: z.string(),
    prompt: z.string().optional(),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
    schedule_value: z.string().optional(),
  },
  async (args) => {
    const data: Record<string, unknown> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) {
      data.prompt = args.prompt;
    }
    if (args.schedule_type !== undefined) {
      data.schedule_type = args.schedule_type;
    }
    if (args.schedule_value !== undefined) {
      data.schedule_value = args.schedule_value;
    }

    writeIpcFile(tasksDir, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  'Register a new chat/group. Main group only.',
  {
    jid: z.string(),
    name: z.string(),
    folder: z.string(),
    trigger: z.string(),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    writeIpcFile(tasksDir, {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered.` }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
