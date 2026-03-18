import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  AgentRuntimeInput,
  AgentRuntimeOutput,
} from './agent-runtime.js';
import { DATA_DIR, GROUPS_DIR, IDLE_TIMEOUT, TIMEZONE } from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { RegisteredConversation } from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const HOST_RUNNER_DIR = path.join(process.cwd(), 'src', 'host-runner');
const RUNTIME_SKILLS_DIR = path.join(process.cwd(), 'src', 'runtime-skills');
const TSX_CLI_PATH = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

interface GroupRunnerSettings {
  claudeDir: string;
  skillsDir: string;
  groupDir: string;
  globalDir: string;
  ipcDir: string;
  runnerDir: string;
  runnerEntry: string;
  runnerArgs: string[];
}

function ensureGroupRunnerSettings(group: RegisteredConversation): GroupRunnerSettings {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const sessionDir = path.join(DATA_DIR, 'sessions', group.folder);
  const claudeDir = path.join(sessionDir, '.claude');
  const skillsDir = path.join(claudeDir, 'skills');
  const ipcDir = resolveGroupIpcPath(group.folder);
  const runnerDir = path.join(sessionDir, 'host-runner');
  const globalDir = path.join(GROUPS_DIR, 'global');

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  const settingsPath = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  if (fs.existsSync(HOST_RUNNER_DIR)) {
    fs.cpSync(HOST_RUNNER_DIR, runnerDir, { recursive: true, force: true });
  }

  if (fs.existsSync(RUNTIME_SKILLS_DIR)) {
    fs.cpSync(RUNTIME_SKILLS_DIR, skillsDir, { recursive: true, force: true });
  }

  const tsRunnerEntry = path.join(runnerDir, 'index.ts');
  const jsRunnerEntry = path.join(runnerDir, 'index.js');
  const runnerEntry = fs.existsSync(jsRunnerEntry) ? jsRunnerEntry : tsRunnerEntry;
  const runnerArgs = runnerEntry.endsWith('.ts')
    ? [TSX_CLI_PATH, runnerEntry]
    : [runnerEntry];

  return {
    claudeDir,
    skillsDir,
    groupDir,
    globalDir,
    ipcDir,
    runnerDir,
    runnerEntry,
    runnerArgs,
  };
}

export async function runHostAgent(
  group: RegisteredConversation,
  input: AgentRuntimeInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: AgentRuntimeOutput) => Promise<void>,
): Promise<AgentRuntimeOutput> {
  const runtime = ensureGroupRunnerSettings(group);
  const processName = `nanoclaw-host-${group.folder}-${Date.now()}`;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, runtime.runnerArgs, {
      cwd: runtime.groupDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TZ: TIMEZONE,
        NANOCLAW_GROUP_DIR: runtime.groupDir,
        NANOCLAW_GLOBAL_DIR: runtime.globalDir,
        NANOCLAW_IPC_DIR: runtime.ipcDir,
        NANOCLAW_CLAUDE_DIR: runtime.claudeDir,
        NANOCLAW_CHAT_JID: input.chatJid,
        NANOCLAW_CONVERSATION_ID: input.conversationId,
        NANOCLAW_CHANNEL: input.target?.channel,
        NANOCLAW_TARGET_EXTERNAL_ID: input.target?.externalId,
        NANOCLAW_TARGET_PEER_KIND: input.target?.peerKind,
        NANOCLAW_GROUP_FOLDER: input.groupFolder,
        NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
        NANOCLAW_ASSISTANT_NAME: input.assistantName,
        NANOCLAW_TSX_CLI_PATH: TSX_CLI_PATH,
      },
    });

    onProcess(child, processName);

    process.stdout.write(
      `[nanoclaw-host-runner] spawn ${processName} entry=${runtime.runnerEntry}\n`,
    );

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let parseBuffer = '';
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    let newSessionId = input.sessionId;
    let outputChain = Promise.resolve();

    const resetTimeout = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, IDLE_TIMEOUT + 30_000);
    };

    resetTimeout();

    child.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdoutBuffer += chunk;
      parseBuffer += chunk;

      let startIndex = parseBuffer.indexOf(OUTPUT_START_MARKER);
      while (startIndex !== -1) {
        const endIndex = parseBuffer.indexOf(OUTPUT_END_MARKER, startIndex);
        if (endIndex === -1) {
          break;
        }

        const jsonPayload = parseBuffer
          .slice(startIndex + OUTPUT_START_MARKER.length, endIndex)
          .trim();
        parseBuffer = parseBuffer.slice(endIndex + OUTPUT_END_MARKER.length);
        startIndex = parseBuffer.indexOf(OUTPUT_START_MARKER);

        try {
          const parsed = JSON.parse(jsonPayload) as AgentRuntimeOutput;
          if (parsed.newSessionId) {
            newSessionId = parsed.newSessionId;
          }
          resetTimeout();
          if (onOutput) {
            outputChain = outputChain.then(() => onOutput(parsed));
          }
        } catch {
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      stderrBuffer += data.toString();
    });

    child.on('error', (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({
        status: 'error',
        result: null,
        newSessionId,
        error: error.message,
      });
    });

    child.on('close', (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }

      outputChain.then(() => {
        if (timedOut) {
          resolve({
            status: 'error',
            result: null,
            newSessionId,
            error: 'Host agent timed out',
          });
          return;
        }

        if (code !== 0) {
          resolve({
            status: 'error',
            result: null,
            newSessionId,
            error: stderrBuffer.trim() || `Host agent exited with code ${code}`,
          });
          return;
        }

        const startIndex = stdoutBuffer.lastIndexOf(OUTPUT_START_MARKER);
        const endIndex = stdoutBuffer.lastIndexOf(OUTPUT_END_MARKER);
        if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
          const jsonPayload = stdoutBuffer
            .slice(startIndex + OUTPUT_START_MARKER.length, endIndex)
            .trim();
          try {
            const parsed = JSON.parse(jsonPayload) as AgentRuntimeOutput;
            resolve({
              ...parsed,
              newSessionId: parsed.newSessionId || newSessionId,
            });
            return;
          } catch {
          }
        }

        resolve({
          status: 'success',
          result: null,
          newSessionId,
        });
      });
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}
