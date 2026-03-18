import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import path from 'path';

import { AvailableGroup, writeGroupsSnapshot } from './agent-runtime.js';
import {
  ASSISTANT_NAME,
  DATA_DIR,
  ADMIN_BIND_HOST,
  ADMIN_ENABLED,
  ADMIN_PASSWORD,
  ADMIN_PORT,
  ADMIN_SESSION_SECRET,
  ADMIN_SESSION_TTL_MS,
} from './config.js';
import {
  deleteTask,
  getAllChats,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getRouterState,
  getTaskById,
  updateTask,
} from './db.js';
import { logger } from './logger.js';
import { wakeScheduler } from './task-scheduler.js';
import { RegisteredConversation, ScheduledTask } from './types.js';

interface AdminApiDeps {
  getAvailableGroups: () => AvailableGroup[];
  registeredGroups: () => Record<string, RegisteredConversation>;
  syncGroups: (force: boolean) => Promise<void>;
}

interface SessionRecord {
  expiresAt: number;
}

interface LoginRequestBody {
  password?: unknown;
}

interface AdminApiConfig {
  enabled: boolean;
  host: string;
  port: number;
  password: string;
  sessionSecret: string;
  sessionTtlMs: number;
}

interface RuntimeSnapshot<T> {
  groupFolder: string;
  data: T;
}

interface OverviewResponse {
  counts: {
    chats: number;
    registeredGroups: number;
    availableGroups: number;
    tasks: number;
    activeTasks: number;
    pausedTasks: number;
    sessions: number;
  };
  recentChats: ReturnType<typeof getAllChats>;
  recentTasks: ScheduledTask[];
  routerState: {
    lastTimestamp: string | null;
    lastAgentTimestamp: Record<string, string>;
  };
}

const SESSION_COOKIE_NAME = 'nanoclaw_admin_session';

function normalizePath(value: string): string {
  if (!value || value === '/') {
    return '/';
  }
  const normalized = value.replace(/\/+$/, '');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [key, value] of Object.entries(headers || {})) {
    res.setHeader(key, value);
  }
  res.end(JSON.stringify(body));
}

function writeText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(body);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  return await new Promise<string>((resolve, reject) => {
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const rawBody = await readRawBody(req);
  if (!rawBody.trim()) {
    return {};
  }
  return JSON.parse(rawBody) as unknown;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function createSessionSignature(sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(sessionId).digest('hex');
}

function encodeSessionCookie(sessionId: string, secret: string): string {
  return `${sessionId}.${createSessionSignature(sessionId, secret)}`;
}

function decodeSessionCookie(
  cookieValue: string,
  secret: string,
): string | null {
  const separatorIndex = cookieValue.indexOf('.');
  if (separatorIndex === -1) {
    return null;
  }
  const sessionId = cookieValue.slice(0, separatorIndex);
  const signature = cookieValue.slice(separatorIndex + 1);
  const expected = createSessionSignature(sessionId, secret);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    return null;
  }
  if (!timingSafeEqual(left, right)) {
    return null;
  }
  return sessionId;
}

function parseLastAgentTimestamp(): Record<string, string> {
  const raw = getRouterState('last_agent_timestamp');
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function readSnapshotFile(filePath: string): unknown | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function readRuntimeSnapshots(filename: string): Array<RuntimeSnapshot<unknown>> {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  try {
    const result: Array<RuntimeSnapshot<unknown>> = [];
    for (const entry of fs.readdirSync(ipcBaseDir)) {
      try {
        if (!fs.statSync(path.join(ipcBaseDir, entry)).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      const data = readSnapshotFile(path.join(ipcBaseDir, entry, filename));
      if (data === null) {
        continue;
      }
      result.push({ groupFolder: entry, data });
    }
    return result;
  } catch {
    return [];
  }
}

function getMainGroupFolder(
  registeredGroups: Record<string, RegisteredConversation>,
): string | null {
  for (const group of Object.values(registeredGroups)) {
    if (group.isMain) {
      return group.folder;
    }
  }
  return null;
}

function buildOverview(
  deps: AdminApiDeps,
): OverviewResponse {
  const chats = getAllChats();
  const tasks = getAllTasks();
  const sessions = getAllSessions();
  const registeredGroups = deps.registeredGroups();
  const availableGroups = deps.getAvailableGroups();

  return {
    counts: {
      chats: chats.length,
      registeredGroups: Object.keys(registeredGroups).length,
      availableGroups: availableGroups.length,
      tasks: tasks.length,
      activeTasks: tasks.filter((task) => task.status === 'active').length,
      pausedTasks: tasks.filter((task) => task.status === 'paused').length,
      sessions: Object.keys(sessions).length,
    },
    recentChats: chats.slice(0, 10),
    recentTasks: tasks.slice(0, 10),
    routerState: {
      lastTimestamp: getRouterState('last_timestamp') || null,
      lastAgentTimestamp: parseLastAgentTimestamp(),
    },
  };
}

export class AdminApiService {
  private readonly config: AdminApiConfig;
  private readonly deps: AdminApiDeps;
  private readonly sessions = new Map<string, SessionRecord>();
  private server: Server | null = null;

  constructor(deps: AdminApiDeps) {
    this.deps = deps;
    this.config = {
      enabled: ADMIN_ENABLED,
      host: ADMIN_BIND_HOST,
      port: ADMIN_PORT,
      password: ADMIN_PASSWORD,
      sessionSecret: ADMIN_SESSION_SECRET,
      sessionTtlMs: ADMIN_SESSION_TTL_MS,
    };
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('Admin API disabled');
      return;
    }
    if (!this.config.password) {
      logger.warn('Admin API enabled but ADMIN_PASSWORD is not configured');
      return;
    }
    if (this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handleRequest(req, res).catch((error: unknown) => {
          logger.error({ err: error }, 'Admin API request failed');
          if (!res.headersSent) {
            writeJson(res, 500, { error: 'internal_error' });
          }
        });
      });
      server.listen(this.config.port, this.config.host, () => {
        logger.info(
          {
            host: this.config.host,
            port: this.config.port,
          },
          'Admin API server started',
        );
        this.server = server;
        resolve();
      });
      server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [sessionId, record] of this.sessions.entries()) {
      if (record.expiresAt <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private createSession(): string {
    const sessionId = randomBytes(24).toString('hex');
    this.sessions.set(sessionId, {
      expiresAt: Date.now() + this.config.sessionTtlMs,
    });
    return sessionId;
  }

  private authenticateRequest(req: IncomingMessage): boolean {
    this.cleanupExpiredSessions();
    const cookies = parseCookies(req.headers.cookie);
    const rawSession = cookies[SESSION_COOKIE_NAME];
    if (!rawSession) {
      return false;
    }
    const sessionId = decodeSessionCookie(rawSession, this.config.sessionSecret);
    if (!sessionId) {
      return false;
    }
    const record = this.sessions.get(sessionId);
    if (!record) {
      return false;
    }
    record.expiresAt = Date.now() + this.config.sessionTtlMs;
    return true;
  }

  private clearSession(req: IncomingMessage): void {
    const cookies = parseCookies(req.headers.cookie);
    const rawSession = cookies[SESSION_COOKIE_NAME];
    if (!rawSession) {
      return;
    }
    const sessionId = decodeSessionCookie(rawSession, this.config.sessionSecret);
    if (!sessionId) {
      return;
    }
    this.sessions.delete(sessionId);
  }

  private buildSessionCookie(sessionId: string): string {
    const encoded = encodeSessionCookie(sessionId, this.config.sessionSecret);
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(encoded)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(this.config.sessionTtlMs / 1000)}`;
  }

  private buildExpiredSessionCookie(): string {
    return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    const parsed = (await readJsonBody(req)) as LoginRequestBody;
    if (typeof parsed.password !== 'string') {
      writeJson(res, 400, { error: 'invalid_request' });
      return;
    }

    const supplied = Buffer.from(parsed.password);
    const expected = Buffer.from(this.config.password);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      writeJson(res, 401, { error: 'invalid_credentials' });
      return;
    }

    const sessionId = this.createSession();
    writeJson(
      res,
      200,
      { ok: true },
      { 'Set-Cookie': this.buildSessionCookie(sessionId) },
    );
  }

  private async handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    this.clearSession(req);
    writeJson(
      res,
      200,
      { ok: true },
      { 'Set-Cookie': this.buildExpiredSessionCookie() },
    );
  }

  private async handleTasksAction(
    req: IncomingMessage,
    res: ServerResponse,
    taskId: string,
    action: 'pause' | 'resume' | 'cancel',
  ): Promise<void> {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    const task = getTaskById(taskId);
    if (!task) {
      writeJson(res, 404, { error: 'task_not_found' });
      return;
    }

    if (action === 'pause') {
      updateTask(taskId, { status: 'paused' });
    } else if (action === 'resume') {
      updateTask(taskId, { status: 'active' });
    } else {
      deleteTask(taskId);
    }

    wakeScheduler();

    writeJson(res, 200, {
      ok: true,
      action,
      taskId,
    });
  }

  private async handleGroupsRefresh(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    await this.deps.syncGroups(true);
    const registeredGroups = this.deps.registeredGroups();
    const mainGroupFolder = getMainGroupFolder(registeredGroups);
    if (mainGroupFolder) {
      writeGroupsSnapshot(
        mainGroupFolder,
        true,
        this.deps.getAvailableGroups(),
        new Set(Object.keys(registeredGroups)),
      );
    }
    writeJson(res, 200, { ok: true });
  }

  private async handleProtectedRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (!this.authenticateRequest(req)) {
      writeJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (pathname === '/api/admin/overview') {
      writeJson(res, 200, buildOverview(this.deps));
      return;
    }

    if (pathname === '/api/admin/chats') {
      const registeredGroups = this.deps.registeredGroups();
      const chats = getAllChats().map((chat) => ({
        ...chat,
        conversationId: chat.conversation_id,
        isRegistered: Boolean(registeredGroups[chat.jid]),
        registeredGroup: registeredGroups[chat.jid] || null,
      }));
      writeJson(res, 200, { chats });
      return;
    }

    if (pathname.startsWith('/api/admin/chats/') && pathname.endsWith('/messages')) {
      const chatJid = decodeURIComponent(
        pathname.slice('/api/admin/chats/'.length, pathname.length - '/messages'.length),
      );
      const url = new URL(req.url || '/', 'http://localhost');
      const since = url.searchParams.get('since') || '';
      const limitValue = url.searchParams.get('limit');
      const parsedLimit = limitValue ? Number.parseInt(limitValue, 10) : 200;
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 500)
        : 200;
      const messages = getMessagesSince(chatJid, since, ASSISTANT_NAME, limit);
      const chats = getAllChats();
      const chat = chats.find((entry) => entry.jid === chatJid) || null;
      writeJson(res, 200, {
        chatJid,
        conversationId: chat?.conversation_id || null,
        messages,
      });
      return;
    }

    if (pathname === '/api/admin/tasks') {
      writeJson(res, 200, { tasks: getAllTasks() });
      return;
    }

    if (pathname.startsWith('/api/admin/tasks/')) {
      const suffix = pathname.slice('/api/admin/tasks/'.length);
      const parts = suffix.split('/').filter((part) => part.length > 0);
      if (parts.length === 1) {
        const taskId = decodeURIComponent(parts[0]);
        const task = getTaskById(taskId);
        if (!task) {
          writeJson(res, 404, { error: 'task_not_found' });
          return;
        }
        writeJson(res, 200, { task });
        return;
      }
      if (parts.length === 2) {
        const taskId = decodeURIComponent(parts[0]);
        if (parts[1] === 'pause' || parts[1] === 'resume' || parts[1] === 'cancel') {
          await this.handleTasksAction(req, res, taskId, parts[1]);
          return;
        }
      }
    }

    if (pathname === '/api/admin/groups') {
      const registeredGroups = this.deps.registeredGroups();
      const availableGroups = this.deps.getAvailableGroups();
      writeJson(res, 200, {
        registeredGroups,
        availableGroups,
        mainGroupFolder: getMainGroupFolder(registeredGroups),
      });
      return;
    }

    if (pathname === '/api/admin/groups/refresh') {
      await this.handleGroupsRefresh(req, res);
      return;
    }

    if (pathname === '/api/admin/runtime') {
      writeJson(res, 200, {
        sessions: getAllSessions(),
        routerState: {
          lastTimestamp: getRouterState('last_timestamp') || null,
          lastAgentTimestamp: parseLastAgentTimestamp(),
        },
        currentTasksSnapshots: readRuntimeSnapshots('current_tasks.json'),
        availableGroupsSnapshots: readRuntimeSnapshots('available_groups.json'),
      });
      return;
    }

    writeJson(res, 404, { error: 'not_found' });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = normalizePath(url.pathname);

    if (pathname === '/healthz') {
      writeText(res, 200, 'ok');
      return;
    }

    if (pathname === '/api/admin/login') {
      await this.handleLogin(req, res);
      return;
    }

    if (pathname === '/api/admin/logout') {
      await this.handleLogout(req, res);
      return;
    }

    await this.handleProtectedRequest(req, res, pathname);
  }
}
