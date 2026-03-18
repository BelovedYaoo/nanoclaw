import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  HookCallback,
  PreCompactHookInput,
  query,
} from '@anthropic-ai/claude-agent-sdk';

interface RuntimeInput {
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

interface RuntimeOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const IPC_DIR = process.env.NANOCLAW_IPC_DIR ?? '';
const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR ?? process.cwd();
const GLOBAL_DIR = process.env.NANOCLAW_GLOBAL_DIR ?? '';
const CLAUDE_DIR = process.env.NANOCLAW_CLAUDE_DIR ?? '';
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next) {
          yield next;
        }
      }
      if (this.done) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: RuntimeOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as SessionsIndex;
    const entry = index.entries.find((candidate) => candidate.sessionId === sessionId);
    return entry?.summary ?? null;
  } catch {
    return null;
  }
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

function parseTranscript(content: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
      };
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((part) => part.text ?? '').join('');
        if (text) {
          messages.push({ role: 'user', content: text });
        }
      } else if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
        const text = entry.message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('');
        if (text) {
          messages.push({ role: 'assistant', content: text });
        }
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: TranscriptMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const message of messages) {
    const sender = message.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = message.content.length > 2000
      ? `${message.content.slice(0, 2000)}...`
      : message.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) {
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const conversationsDir = path.join(GROUP_DIR, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const filename = `${new Date().toISOString().split('T')[0]}-${summary ? sanitizeFilename(summary) : generateFallbackName()}.md`;
      fs.writeFileSync(
        path.join(conversationsDir, filename),
        formatTranscriptMarkdown(messages, summary, assistantName),
      );
    } catch {
    }

    return {};
  };
}

function shouldClose(): boolean {
  if (!fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    return false;
  }
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
  }
  return true;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((file) => file.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
          type?: string;
          text?: string;
        };
        fs.unlinkSync(filePath);
        if (parsed.type === 'message' && parsed.text) {
          messages.push(parsed.text);
        }
      } catch {
        try {
          fs.unlinkSync(filePath);
        } catch {
        }
      }
    }
    return messages;
  } catch {
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServer: { command: string; args: string[] },
  runtimeInput: RuntimeInput,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) {
      return;
    }
    if (shouldClose()) {
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;

  const globalClaudeMdPath = path.join(GLOBAL_DIR, 'CLAUDE.md');
  const globalClaudeMd = !runtimeInput.isMain && fs.existsSync(globalClaudeMdPath)
    ? fs.readFileSync(globalClaudeMdPath, 'utf-8')
    : undefined;

  const extraDirs: string[] = [];

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: GROUP_DIR,
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset', preset: 'claude_code', append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
      ],
      env: {
        ...process.env,
        HOME: CLAUDE_DIR,
      },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: mcpServer.command,
          args: mcpServer.args,
          env: {
            ...process.env,
            NANOCLAW_CHAT_JID: runtimeInput.chatJid,
            NANOCLAW_CONVERSATION_ID: runtimeInput.conversationId || '',
            NANOCLAW_CHANNEL: runtimeInput.target?.channel || '',
            NANOCLAW_TARGET_EXTERNAL_ID: runtimeInput.target?.externalId || '',
            NANOCLAW_TARGET_PEER_KIND: runtimeInput.target?.peerKind || '',
            NANOCLAW_GROUP_FOLDER: runtimeInput.groupFolder,
            NANOCLAW_IS_MAIN: runtimeInput.isMain ? '1' : '0',
            NANOCLAW_IPC_DIR: IPC_DIR,
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(runtimeInput.assistantName)] }],
      },
    },
  })) {
    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = message.uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
    }

    if (message.type === 'result') {
      const textResult = 'result' in message ? message.result : null;
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
      });
    }
  }

  ipcPolling = false;
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  let runtimeInput: RuntimeInput;

  try {
    runtimeInput = JSON.parse(await readStdin()) as RuntimeInput;
  } catch (error) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${error instanceof Error ? error.message : String(error)}`,
    });
    process.exit(1);
    return;
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const tsxCliPath = process.env.NANOCLAW_TSX_CLI_PATH ?? '';
  const jsMcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  const tsMcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.ts');
  const mcpServer = fs.existsSync(jsMcpServerPath)
    ? { command: process.execPath, args: [jsMcpServerPath] }
    : { command: process.execPath, args: [tsxCliPath, tsMcpServerPath] };

  let sessionId = runtimeInput.sessionId;
  let prompt = runtimeInput.prompt;
  if (!runtimeInput.isScheduledTask) {
    prompt = `${prompt}\n\n[系统提示] 如果用户要求稍后提醒、定时执行、周期执行，请优先使用 nanoclaw MCP 的 schedule_task 工具创建持久化任务，而不是仅做会话内提醒。只有在用户明确要求一次性临时会话提醒时，才可以不创建持久化任务。`;
  }
  if (runtimeInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += `\n${pending.join('\n')}`;
  }

  let resumeAt: string | undefined;
  try {
    while (true) {
      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServer,
        runtimeInput,
        resumeAt,
      );

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }
      if (queryResult.closedDuringQuery) {
        break;
      }

      writeOutput({ status: 'success', result: null, newSessionId: sessionId });
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        break;
      }
      prompt = nextMessage;
    }
  } catch (error) {
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

main();
