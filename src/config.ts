import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// 从 .env 读取基础配置（若进程环境变量存在则优先使用）。
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ADMIN_ENABLED',
  'ADMIN_BIND_HOST',
  'ADMIN_PORT',
  'ADMIN_PASSWORD',
  'ADMIN_SESSION_SECRET',
  'ADMIN_SESSION_TTL_MS',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10);
export const MAX_CONCURRENT_AGENTS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_AGENTS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

export const ADMIN_ENABLED =
  (process.env.ADMIN_ENABLED || envConfig.ADMIN_ENABLED || 'false') === 'true';
export const ADMIN_BIND_HOST =
  process.env.ADMIN_BIND_HOST || envConfig.ADMIN_BIND_HOST || '127.0.0.1';
export const ADMIN_PORT = parseInt(
  process.env.ADMIN_PORT || envConfig.ADMIN_PORT || '3210',
  10,
);
export const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || envConfig.ADMIN_PASSWORD || '';
export const ADMIN_SESSION_SECRET =
  process.env.ADMIN_SESSION_SECRET ||
  envConfig.ADMIN_SESSION_SECRET ||
  'nanoclaw-admin-session-secret';
export const ADMIN_SESSION_TTL_MS = parseInt(
  process.env.ADMIN_SESSION_TTL_MS || envConfig.ADMIN_SESSION_TTL_MS || '43200000',
  10,
);
