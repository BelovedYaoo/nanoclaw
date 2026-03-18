import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  ConversationId,
  MessageTarget,
  NewMessage,
  RegisteredConversation,
  ScheduledTask,
} from './types.js';

const DB_SCHEMA_VERSION = '3';

let db: Database.Database;

function upsertConversation(params: {
  target: MessageTarget;
  name: string;
  timestamp: string;
}): ConversationId {
  const conversationId = params.target.conversationId;

  db.prepare(
    `
    INSERT INTO conversations (
      id,
      channel,
      external_id,
      peer_kind,
      account_id,
      legacy_chat_jid,
      display_name,
      is_group,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      channel = excluded.channel,
      external_id = excluded.external_id,
      peer_kind = excluded.peer_kind,
      account_id = COALESCE(excluded.account_id, conversations.account_id),
      legacy_chat_jid = excluded.legacy_chat_jid,
      display_name = excluded.display_name,
      is_group = excluded.is_group,
      updated_at = CASE
        WHEN excluded.updated_at > conversations.updated_at THEN excluded.updated_at
        ELSE conversations.updated_at
      END
  `,
  ).run(
    conversationId,
    params.target.channel,
    params.target.externalId,
    params.target.peerKind,
    params.target.accountId ?? null,
    params.target.chatJid,
    params.name,
    params.target.isGroup ? 1 : 0,
    params.timestamp,
    params.timestamp,
  );

  return conversationId;
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE chats (
      jid TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL UNIQUE,
      name TEXT,
      last_message_time TEXT,
      channel TEXT NOT NULL,
      is_group INTEGER DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
    CREATE INDEX idx_chats_conversation_id ON chats(conversation_id);

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      external_id TEXT NOT NULL,
      peer_kind TEXT NOT NULL,
      account_id TEXT,
      legacy_chat_jid TEXT UNIQUE,
      display_name TEXT NOT NULL,
      is_group INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_conversations_channel ON conversations(channel);
    CREATE INDEX idx_conversations_legacy_chat_jid ON conversations(legacy_chat_jid);

    CREATE TABLE messages (
      id TEXT,
      conversation_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      message_type TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      mentioned_bot INTEGER DEFAULT 0,
      trigger_matched INTEGER DEFAULT 0,
      trigger_source TEXT DEFAULT 'none',
      PRIMARY KEY (id, conversation_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX idx_timestamp ON messages(timestamp);
    CREATE INDEX idx_messages_chat_jid ON messages(chat_jid);

    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX idx_status ON scheduled_tasks(status);

    CREATE TABLE router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
    CREATE TABLE registrations (
      conversation_id TEXT PRIMARY KEY,
      jid TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
  `);

  database
    .prepare(`INSERT OR REPLACE INTO router_state (key, value) VALUES ('schema_version', ?)`)
    .run(DB_SCHEMA_VERSION);
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let shouldRecreate = !fs.existsSync(dbPath);

  if (!shouldRecreate) {
    const existingDb = new Database(dbPath, { readonly: true });
    try {
      const state = existingDb
        .prepare(`SELECT value FROM router_state WHERE key = 'schema_version'`)
        .get() as { value: string } | undefined;
      shouldRecreate = state?.value !== DB_SCHEMA_VERSION;
    } catch {
      shouldRecreate = true;
    } finally {
      existingDb.close();
    }
  }

  if (shouldRecreate && fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { force: true });
  }

  db = new Database(dbPath);
  if (shouldRecreate) {
    createSchema(db);
  }
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  target: MessageTarget,
  timestamp: string,
  name?: string,
): void {
  const resolvedName = name || target.chatJid;
  const conversationId = upsertConversation({
    target,
    name: resolvedName,
    timestamp,
  });

  db.prepare(
    `
    INSERT INTO chats (jid, conversation_id, name, last_message_time, channel, is_group)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      name = excluded.name,
      last_message_time = MAX(chats.last_message_time, excluded.last_message_time),
      channel = excluded.channel,
      is_group = excluded.is_group
  `,
  ).run(
    target.chatJid,
    conversationId,
    resolvedName,
    timestamp,
    target.channel,
    target.isGroup ? 1 : 0,
  );
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(target: MessageTarget, name: string): void {
  const now = new Date().toISOString();
  const conversationId = upsertConversation({
    target,
    name,
    timestamp: now,
  });

  db.prepare(
    `
    INSERT INTO chats (jid, conversation_id, name, last_message_time, channel, is_group)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      name = excluded.name
  `,
  ).run(
    target.chatJid,
    conversationId,
    name,
    now,
    target.channel,
    target.isGroup ? 1 : 0,
  );
}

export interface ChatInfo {
  jid: string;
  conversation_id: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, conversation_id, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

export function getChatByJid(chatJid: string): ChatInfo | undefined {
  return db
    .prepare(
      `
    SELECT jid, conversation_id, name, last_message_time, channel, is_group
    FROM chats
    WHERE jid = ?
  `,
    )
    .get(chatJid) as ChatInfo | undefined;
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  const conversationId = upsertConversation({
    target: {
      conversationId: 'conv:__group_sync__',
      chatJid: '__group_sync__',
      channel: 'system',
      externalId: '__group_sync__',
      peerKind: 'system',
      isGroup: false,
    },
    name: '__group_sync__',
    timestamp: now,
  });
  db.prepare(
    `
    INSERT OR REPLACE INTO chats (jid, conversation_id, name, last_message_time, channel, is_group)
    VALUES ('__group_sync__', ?, '__group_sync__', ?, 'system', 0)
  `,
  ).run(conversationId, now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(target: MessageTarget, msg: NewMessage): void {
  const conversationId =
    msg.conversation_id ||
    upsertConversation({
      target,
      name: msg.sender_name || target.chatJid,
      timestamp: msg.timestamp,
    });

  db.prepare(
    `
    INSERT OR REPLACE INTO messages (
      id,
      conversation_id,
      chat_jid,
      sender,
      sender_name,
      content,
      timestamp,
      message_type,
      is_from_me,
      is_bot_message,
      mentioned_bot,
      trigger_matched,
      trigger_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    msg.id,
    conversationId,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.message_type ?? null,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.mentioned_bot ? 1 : 0,
    msg.trigger_matched ? 1 : 0,
    msg.trigger_source ?? 'none',
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(
  target: MessageTarget,
  msg: {
    id: string;
    chat_jid: string;
    conversation_id?: ConversationId;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    message_type?: string;
    is_from_me: boolean;
    is_bot_message?: boolean;
    mentioned_bot?: boolean;
    trigger_matched?: boolean;
    trigger_source?: 'mention' | 'text' | 'system' | 'none';
  },
): void {
  const conversationId =
    msg.conversation_id ||
    upsertConversation({
      target,
      name: msg.sender_name || target.chatJid,
      timestamp: msg.timestamp,
    });

  db.prepare(
    `
    INSERT OR REPLACE INTO messages (
      id,
      conversation_id,
      chat_jid,
      sender,
      sender_name,
      content,
      timestamp,
      message_type,
      is_from_me,
      is_bot_message,
      mentioned_bot,
      trigger_matched,
      trigger_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    msg.id,
    conversationId,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.message_type ?? null,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.mentioned_bot ? 1 : 0,
    msg.trigger_matched ? 1 : 0,
    msg.trigger_source ?? 'none',
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, conversation_id, chat_jid, sender, sender_name, content, timestamp, message_type, is_from_me, is_bot_message, mentioned_bot, trigger_matched, trigger_source
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, conversation_id, chat_jid, sender, sender_name, content, timestamp, message_type, is_from_me, is_bot_message, mentioned_bot, trigger_matched, trigger_source
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'> & {
    conversation_id: ConversationId;
  },
): void {
  const conversationId = task.conversation_id;

  db.prepare(
    `
    INSERT INTO scheduled_tasks (
      id,
      group_folder,
      chat_jid,
      conversation_id,
      prompt,
      schedule_type,
      schedule_value,
      context_mode,
      next_run,
      status,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    conversationId,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(nowIso?: string): ScheduledTask[] {
  const now = nowIso || new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function getNextScheduledTask(): ScheduledTask | undefined {
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL
    ORDER BY next_run
    LIMIT 1
  `,
    )
    .get() as ScheduledTask | undefined;
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredConversation & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        conversation_id: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    conversationId: row.conversation_id,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredConversation,
  target: MessageTarget,
): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }

  const conversationId =
    group.conversationId ||
    upsertConversation({
      target,
      name: group.name,
      timestamp: group.added_at,
    });

  db.prepare(
    `
    INSERT OR REPLACE INTO registered_groups (
      jid,
      conversation_id,
      name,
      folder,
      trigger_pattern,
      added_at,
      requires_trigger,
      is_main
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    jid,
    conversationId,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );

  db.prepare(
    `
    INSERT OR REPLACE INTO registrations (
      conversation_id,
      jid,
      name,
      folder,
      trigger_pattern,
      added_at,
      requires_trigger,
      is_main
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    conversationId,
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getRegisteredGroupByFolder(
  folder: string,
): (RegisteredConversation & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE folder = ?')
    .get(folder) as
    | {
        jid: string;
        conversation_id: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    conversationId: row.conversation_id,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function getAllRegisteredGroups(): Record<string, RegisteredConversation> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    conversation_id: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredConversation> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      conversationId: row.conversation_id,
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

