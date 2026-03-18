import crypto from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import { Dispatcher, ProxyAgent } from 'undici';

import { TRIGGER_PATTERN } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { ConversationId, MessageTarget, NewMessage } from './types.js';

export interface WecomAppConfig {
  token: string;
  encodingAESKey: string;
  corpId: string;
  corpSecret: string;
  agentId: number;
  receiveId: string;
  webhookPath: string;
  port: number;
  host: string;
}

export interface WecomAppInboundEnvelope {
  chatJid: string;
  message: NewMessage;
  isGroup: boolean;
  chatName: string;
}

interface WecomAppPlainMessage {
  msgtype?: string;
  MsgType?: string;
  msgid?: string;
  MsgId?: string;
  content?: string;
  Content?: string;
  from?: { userid?: string };
  FromUserName?: string;
  chatid?: string;
  ChatId?: string;
  Action?: string;
  Event?: string;
  EventKey?: string;
  CreateTime?: number;
  AgentID?: number;
  ToUserName?: string;
  Recognition?: string;
  PicUrl?: string;
  atusers?: string[] | string;
  AtUsers?: string[] | string;
  mentioned_list?: string[] | string;
  mentionedList?: string[] | string;
  atuserlist?: string[] | string;
}

interface WecomAppTriggerMetadata {
  messageType: string;
  mentionedBot: boolean;
  triggerMatched: boolean;
  triggerSource: 'mention' | 'text' | 'system' | 'none';
}

const envConfig = readEnvFile([
  'WECOM_APP_TOKEN',
  'WECOM_APP_ENCODING_AES_KEY',
  'WECOM_APP_CORP_ID',
  'WECOM_APP_CORP_SECRET',
  'WECOM_APP_AGENT_ID',
  'WECOM_APP_RECEIVE_ID',
  'WECOM_APP_WEBHOOK_PATH',
  'WECOM_APP_PORT',
  'WECOM_APP_HOST',
  'WECOM_APP_PROXY_URL',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
]);

let accessTokenCache:
  | {
      token: string;
      expiresAt: number;
    }
  | null = null;
let wecomProxyDispatcher: Dispatcher | null | undefined;

function readConfigValue(key: keyof typeof envConfig): string {
  return process.env[key] || envConfig[key] || '';
}

function getWecomProxyUrl(): string {
  return (
    readConfigValue('WECOM_APP_PROXY_URL') ||
    readConfigValue('HTTPS_PROXY') ||
    readConfigValue('HTTP_PROXY') ||
    readConfigValue('ALL_PROXY')
  );
}

function getWecomDispatcher(): Dispatcher | undefined {
  if (wecomProxyDispatcher !== undefined) {
    return wecomProxyDispatcher ?? undefined;
  }

  const proxyUrl = getWecomProxyUrl().trim();
  if (!proxyUrl) {
    wecomProxyDispatcher = null;
    return undefined;
  }

  wecomProxyDispatcher = new ProxyAgent(proxyUrl);
  logger.info({ proxyUrl }, 'WeCom outbound proxy enabled');
  return wecomProxyDispatcher;
}

async function fetchWecom(url: URL, init?: RequestInit): Promise<Response> {
  const dispatcher = getWecomDispatcher();
  const requestInit = {
    ...init,
    dispatcher,
  } as RequestInit & { dispatcher?: Dispatcher };
  return fetch(url, requestInit);
}

export function loadWecomAppConfig(): WecomAppConfig | null {
  const token = readConfigValue('WECOM_APP_TOKEN');
  const encodingAESKey = readConfigValue('WECOM_APP_ENCODING_AES_KEY');
  const corpId = readConfigValue('WECOM_APP_CORP_ID');
  const corpSecret = readConfigValue('WECOM_APP_CORP_SECRET');
  const agentIdRaw = readConfigValue('WECOM_APP_AGENT_ID');

  if (!token || !encodingAESKey || !corpId || !corpSecret || !agentIdRaw) {
    return null;
  }

  const agentId = Number.parseInt(agentIdRaw, 10);
  if (!Number.isFinite(agentId)) {
    logger.warn({ agentIdRaw }, 'Invalid WECOM_APP_AGENT_ID');
    return null;
  }

  const webhookPath = readConfigValue('WECOM_APP_WEBHOOK_PATH') || '/wecom-app/webhook';
  const portRaw = readConfigValue('WECOM_APP_PORT') || '8788';
  const port = Number.parseInt(portRaw, 10);

  return {
    token,
    encodingAESKey,
    corpId,
    corpSecret,
    agentId,
    receiveId: readConfigValue('WECOM_APP_RECEIVE_ID') || corpId,
    webhookPath: normalizePath(webhookPath),
    port: Number.isFinite(port) ? port : 8788,
    host: readConfigValue('WECOM_APP_HOST') || '0.0.0.0',
  };
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '/';
  if (trimmed === '/') return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function decodeEncodingAESKey(encodingAESKey: string): Buffer {
  const normalized = encodingAESKey.trim().endsWith('=')
    ? encodingAESKey.trim()
    : `${encodingAESKey.trim()}=`;
  const key = Buffer.from(normalized, 'base64');
  if (key.length !== 32) {
    throw new Error(`Invalid encoding AES key length: ${key.length}`);
  }
  return key;
}

function sha1Hex(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function computeSignature(params: {
  token: string;
  timestamp: string;
  nonce: string;
  encrypt: string;
}): string {
  return sha1Hex(
    [params.token, params.timestamp, params.nonce, params.encrypt]
      .map((part) => String(part ?? ''))
      .sort()
      .join(''),
  );
}

function verifySignature(params: {
  token: string;
  timestamp: string;
  nonce: string;
  encrypt: string;
  signature: string;
}): boolean {
  return (
    computeSignature({
      token: params.token,
      timestamp: params.timestamp,
      nonce: params.nonce,
      encrypt: params.encrypt,
    }) === params.signature
  );
}

function pkcs7Unpad(buffer: Buffer): Buffer {
  if (buffer.length === 0) {
    throw new Error('Invalid PKCS7 payload');
  }
  const padding = buffer[buffer.length - 1];
  if (!padding || padding < 1 || padding > 32 || padding > buffer.length) {
    throw new Error('Invalid PKCS7 padding');
  }
  for (let index = 1; index <= padding; index += 1) {
    if (buffer[buffer.length - index] !== padding) {
      throw new Error('Invalid PKCS7 padding');
    }
  }
  return buffer.subarray(0, buffer.length - padding);
}

function decryptWecomAppEncrypted(params: {
  encodingAESKey: string;
  receiveId: string;
  encrypt: string;
}): string {
  const aesKey = decodeEncodingAESKey(params.encodingAESKey);
  const iv = aesKey.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(params.encrypt, 'base64')),
    decipher.final(),
  ]);
  const unpadded = pkcs7Unpad(decrypted);
  const msgLength = unpadded.readUInt32BE(16);
  const messageStart = 20;
  const messageEnd = messageStart + msgLength;
  const message = unpadded.subarray(messageStart, messageEnd).toString('utf8');
  const receiveId = unpadded.subarray(messageEnd).toString('utf8');
  if (params.receiveId && receiveId !== params.receiveId) {
    throw new Error('WeCom receiveId mismatch');
  }
  return message;
}

function parseXmlBody(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const cdataPattern = /<([\w:-]+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = cdataPattern.exec(xml)) !== null) {
    const [, key, value] = match;
    result[key] = value;
  }
  const simplePattern = /<([\w:-]+)>([^<]*)<\/\1>/g;
  while ((match = simplePattern.exec(xml)) !== null) {
    const [, key, value] = match;
    if (!(key in result)) {
      result[key] = value;
    }
  }
  return result;
}

function parsePlainMessage(raw: string): WecomAppPlainMessage {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    const xml = parseXmlBody(trimmed);
    return {
      msgtype: xml.MsgType,
      MsgType: xml.MsgType,
      msgid: xml.MsgId,
      MsgId: xml.MsgId,
      content: xml.Content,
      Content: xml.Content,
      from: xml.FromUserName ? { userid: xml.FromUserName } : undefined,
      FromUserName: xml.FromUserName,
      chatid: xml.ChatId,
      ChatId: xml.ChatId,
      Action: xml.Action,
      Event: xml.Event,
      EventKey: xml.EventKey,
      CreateTime: xml.CreateTime ? Number(xml.CreateTime) : undefined,
      AgentID: xml.AgentID ? Number(xml.AgentID) : undefined,
      ToUserName: xml.ToUserName,
      Recognition: xml.Recognition,
      PicUrl: xml.PicUrl,
    };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        msgtype: readStringField(parsed, 'msgtype') ?? readStringField(parsed, 'MsgType'),
        MsgType: readStringField(parsed, 'MsgType') ?? readStringField(parsed, 'msgtype'),
        msgid: readStringField(parsed, 'msgid') ?? readStringField(parsed, 'MsgId'),
        MsgId: readStringField(parsed, 'MsgId') ?? readStringField(parsed, 'msgid'),
        content: readStringField(parsed, 'content') ?? readStringField(parsed, 'Content'),
        Content: readStringField(parsed, 'Content') ?? readStringField(parsed, 'content'),
        from: readNestedSender(parsed),
        FromUserName: readStringField(parsed, 'FromUserName'),
        chatid: readStringField(parsed, 'chatid') ?? readStringField(parsed, 'ChatId'),
        ChatId: readStringField(parsed, 'ChatId') ?? readStringField(parsed, 'chatid'),
        Action: readStringField(parsed, 'Action'),
        Event: readStringField(parsed, 'Event'),
        EventKey: readStringField(parsed, 'EventKey'),
        CreateTime: readNumberField(parsed, 'CreateTime'),
        AgentID: readNumberField(parsed, 'AgentID'),
        ToUserName: readStringField(parsed, 'ToUserName'),
        Recognition: readStringField(parsed, 'Recognition'),
        PicUrl: readStringField(parsed, 'PicUrl'),
        atusers: readStringArrayField(parsed, 'atusers'),
        AtUsers: readStringArrayField(parsed, 'AtUsers'),
        mentioned_list: readStringArrayField(parsed, 'mentioned_list'),
        mentionedList: readStringArrayField(parsed, 'mentionedList'),
        atuserlist: readStringArrayField(parsed, 'atuserlist'),
      };
    }
  } catch {
    logger.warn('Failed to parse WeCom plain message as JSON');
  }
  return {};
}

function readStringField(source: object, key: string): string | undefined {
  const value = Reflect.get(source, key);
  return typeof value === 'string' ? value : undefined;
}

function readNumberField(source: object, key: string): number | undefined {
  const value = Reflect.get(source, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readNestedSender(source: object): { userid?: string } | undefined {
  const value = Reflect.get(source, 'from');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const userId = readStringField(value, 'userid');
  return userId ? { userid: userId } : undefined;
}

function readStringArrayField(source: object, key: string): string[] | string | undefined {
  const value = Reflect.get(source, key);
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length > 0 ? items : undefined;
}

function collectMentionedIds(message: WecomAppPlainMessage): string[] {
  const sources = [
    message.atusers,
    message.AtUsers,
    message.mentioned_list,
    message.mentionedList,
    message.atuserlist,
  ];
  const ids = new Set<string>();

  for (const source of sources) {
    if (typeof source === 'string') {
      for (const part of source.split(/[;,\s]+/)) {
        const normalized = part.trim();
        if (normalized) {
          ids.add(normalized);
        }
      }
      continue;
    }
    if (!source) {
      continue;
    }
    for (const item of source) {
      const normalized = item.trim();
      if (normalized) {
        ids.add(normalized);
      }
    }
  }

  return [...ids];
}

function resolveWecomTriggerMetadata(
  message: WecomAppPlainMessage,
  config: WecomAppConfig,
  isGroup: boolean,
  content: string,
): WecomAppTriggerMetadata {
  const messageType = String(message.msgtype ?? message.MsgType ?? '').toLowerCase() || 'unknown';
  if (!isGroup) {
    return {
      messageType,
      mentionedBot: false,
      triggerMatched: true,
      triggerSource: 'system',
    };
  }

  const mentionedIds = collectMentionedIds(message);
  const botMentionCandidates = new Set([
    config.receiveId,
    config.corpId,
    String(config.agentId),
    'notify@all',
    '@all',
  ]);
  const mentionedBot = mentionedIds.some((item) => botMentionCandidates.has(item));
  if (mentionedBot) {
    return {
      messageType,
      mentionedBot: true,
      triggerMatched: true,
      triggerSource: 'mention',
    };
  }

  if (content && TRIGGER_PATTERN.test(content.trim())) {
    return {
      messageType,
      mentionedBot: false,
      triggerMatched: true,
      triggerSource: 'text',
    };
  }

  return {
    messageType,
    mentionedBot: false,
    triggerMatched: false,
    triggerSource: 'none',
  };
}

function extractMessageContent(message: WecomAppPlainMessage): string {
  const msgType = String(message.msgtype ?? message.MsgType ?? '').toLowerCase();
  if (msgType === 'text') {
    return String(message.content ?? message.Content ?? '').trim();
  }
  if (msgType === 'voice') {
    const recognition = String(message.Recognition ?? '').trim();
    return recognition || '[voice]';
  }
  if (msgType === 'image') {
    const url = String(message.PicUrl ?? '').trim();
    return url ? `[image] ${url}` : '[image]';
  }
  if (msgType === 'event') {
    const event = String(message.Event ?? message.EventKey ?? message.Action ?? '').trim();
    return event ? `[event] ${event}` : '[event]';
  }
  return `[${msgType || 'unknown'}]`;
}

function isUsableInboundMessage(message: WecomAppPlainMessage): boolean {
  const msgType = String(message.msgtype ?? message.MsgType ?? '').toLowerCase();
  if (!msgType) {
    return false;
  }
  if (msgType === 'event') {
    return false;
  }
  return true;
}

function resolveSenderId(message: WecomAppPlainMessage): string {
  return (
    message.from?.userid?.trim() ||
    message.FromUserName?.trim() ||
    'unknown'
  );
}

function resolveChatId(message: WecomAppPlainMessage, senderId: string): string {
  const chatId = message.chatid?.trim() || message.ChatId?.trim();
  if (chatId) {
    return `wecom-app:group:${chatId}`;
  }
  return `wecom-app:user:${senderId}`;
}

function resolveChatName(message: WecomAppPlainMessage, senderId: string): string {
  const chatId = message.chatid?.trim() || message.ChatId?.trim();
  if (chatId) {
    return `WeCom Group ${chatId}`;
  }
  return `WeCom User ${senderId}`;
}

function resolveTimestamp(message: WecomAppPlainMessage): string {
  const seconds = message.CreateTime;
  if (typeof seconds === 'number' && Number.isFinite(seconds)) {
    return new Date(seconds * 1000).toISOString();
  }
  return new Date().toISOString();
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

function writeText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(body);
}

export class WecomAppService {
  private readonly config: WecomAppConfig;
  private readonly onMessage: (payload: WecomAppInboundEnvelope) => void;
  private server: Server | null = null;

  constructor(params: {
    config: WecomAppConfig;
    onMessage: (payload: WecomAppInboundEnvelope) => void;
  }) {
    this.config = params.config;
    this.onMessage = params.onMessage;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handleRequest(req, res).catch((error: unknown) => {
          logger.error({ err: error }, 'WeCom webhook request failed');
          if (!res.headersSent) {
            writeText(res, 500, 'internal error');
          }
        });
      });
      server.listen(this.config.port, this.config.host, () => {
        logger.info(
          {
            host: this.config.host,
            port: this.config.port,
            path: this.config.webhookPath,
          },
          'WeCom App webhook server started',
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

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    logger.info(
      {
        method: req.method || 'UNKNOWN',
        path: url.pathname,
        query: url.search,
      },
      'WeCom webhook request received',
    );
    if (normalizePath(url.pathname) !== this.config.webhookPath) {
      logger.warn(
        {
          actualPath: url.pathname,
          expectedPath: this.config.webhookPath,
        },
        'WeCom webhook path mismatch',
      );
      writeText(res, 404, 'not found');
      return;
    }

    const signature =
      url.searchParams.get('msg_signature') ||
      url.searchParams.get('msgsignature') ||
      url.searchParams.get('signature') ||
      '';
    const timestamp = url.searchParams.get('timestamp') || '';
    const nonce = url.searchParams.get('nonce') || '';

    if (req.method === 'GET') {
      const echostr = url.searchParams.get('echostr') || '';
      logger.info(
        {
          hasSignature: Boolean(signature),
          hasTimestamp: Boolean(timestamp),
          hasNonce: Boolean(nonce),
          hasEchoStr: Boolean(echostr),
        },
        'WeCom webhook verification request received',
      );
      if (
        !verifySignature({
          token: this.config.token,
          timestamp,
          nonce,
          encrypt: echostr,
          signature,
        })
      ) {
        logger.warn('WeCom webhook verification signature invalid');
        writeText(res, 401, 'invalid signature');
        return;
      }
      const plain = decryptWecomAppEncrypted({
        encodingAESKey: this.config.encodingAESKey,
        receiveId: this.config.receiveId,
        encrypt: echostr,
      });
      logger.info({ plain }, 'WeCom webhook verification succeeded');
      writeText(res, 200, plain);
      return;
    }

    if (req.method !== 'POST') {
      logger.warn({ method: req.method || 'UNKNOWN' }, 'WeCom webhook method not allowed');
      writeText(res, 405, 'method not allowed');
      return;
    }

    const rawBody = await readRawBody(req);
    logger.info(
      {
        rawBodyLength: rawBody.length,
        rawBodyPreview: rawBody.slice(0, 300),
      },
      'WeCom webhook POST body received',
    );
    const outer = parseXmlBody(rawBody);
    const encrypted = outer.Encrypt || '';

    let plainPayload = rawBody;
    if (encrypted) {
      logger.info({ encryptedLength: encrypted.length }, 'WeCom webhook encrypted payload detected');
      if (
        !verifySignature({
          token: this.config.token,
          timestamp,
          nonce,
          encrypt: encrypted,
          signature,
        })
      ) {
        logger.warn('WeCom webhook POST signature invalid');
        writeText(res, 401, 'invalid signature');
        return;
      }
      plainPayload = decryptWecomAppEncrypted({
        encodingAESKey: this.config.encodingAESKey,
        receiveId: this.config.receiveId,
        encrypt: encrypted,
      });
      logger.info(
        {
          plainPayloadLength: plainPayload.length,
          plainPayloadPreview: plainPayload.slice(0, 300),
        },
        'WeCom webhook payload decrypted',
      );
    } else {
      logger.info('WeCom webhook payload is not encrypted');
    }

    const message = parsePlainMessage(plainPayload);
    logger.info(
      {
        msgType: String(message.msgtype ?? message.MsgType ?? ''),
        msgId: String(message.msgid ?? message.MsgId ?? ''),
        fromUserName: String(message.FromUserName ?? message.from?.userid ?? ''),
        chatId: String(message.ChatId ?? message.chatid ?? ''),
      },
      'WeCom webhook message parsed',
    );
    if (!isUsableInboundMessage(message)) {
      logger.info('WeCom webhook message ignored because it is not a usable inbound message');
      writeText(res, 200, 'success');
      return;
    }

    const senderId = resolveSenderId(message);
    const chatJid = resolveChatId(message, senderId);
    const timestampIso = resolveTimestamp(message);
    const content = extractMessageContent(message);
    const isGroup = chatJid.startsWith('wecom-app:group:');
    const triggerMetadata = resolveWecomTriggerMetadata(message, this.config, isGroup, content);

    logger.info(
      {
        senderId,
        chatJid,
        isGroup,
        timestamp: timestampIso,
        content,
      },
      'WeCom inbound message dispatched to NanoClaw',
    );

    this.onMessage({
      chatJid,
      isGroup,
      chatName: resolveChatName(message, senderId),
      message: {
        id: String(message.msgid ?? message.MsgId ?? `${Date.now()}-${senderId}`),
        chat_jid: chatJid,
        sender: `wecom-app:user:${senderId}`,
        sender_name: senderId,
        content,
        timestamp: timestampIso,
        message_type: triggerMetadata.messageType,
        is_from_me: false,
        mentioned_bot: triggerMetadata.mentionedBot,
        trigger_matched: triggerMetadata.triggerMatched,
        trigger_source: triggerMetadata.triggerSource,
      },
    });

    logger.info({ chatJid }, 'WeCom webhook request completed successfully');
    writeText(res, 200, 'success');
  }
}

async function getAccessToken(config: WecomAppConfig): Promise<string> {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now()) {
    logger.info('WeCom access token cache hit');
    return accessTokenCache.token;
  }

  logger.info('Fetching WeCom access token');
  const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken');
  url.searchParams.set('corpid', config.corpId);
  url.searchParams.set('corpsecret', config.corpSecret);

  const response = await fetchWecom(url);
  if (!response.ok) {
    throw new Error(`WeCom gettoken failed: ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object') {
    throw new Error('WeCom gettoken returned invalid payload');
  }

  const record = payload as {
    access_token?: unknown;
    expires_in?: unknown;
    errmsg?: unknown;
  };
  if (typeof record.access_token !== 'string' || !record.access_token) {
    throw new Error(
      `WeCom gettoken failed: ${String(record.errmsg ?? 'missing token')}`,
    );
  }

  const expiresIn =
    typeof record.expires_in === 'number' && Number.isFinite(record.expires_in)
      ? record.expires_in
      : 7200;

  accessTokenCache = {
    token: record.access_token,
    expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000,
  };

  logger.info({ expiresIn }, 'WeCom access token fetched');
  return record.access_token;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '').trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1 ($2)')
    .trim();
}

function splitText(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (current && currentBytes + charBytes > maxBytes) {
      chunks.push(current);
      current = char;
      currentBytes = charBytes;
      continue;
    }
    current += char;
    currentBytes += charBytes;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [''];
}

const BARE_USER_ID_RE = /^[a-z0-9][a-z0-9._@-]{0,63}$/;
const EXPLICIT_USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

function looksLikeEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

export function normalizeWecomAppTarget(rawTarget: string): string | undefined {
  const parsed = parseWecomAppDirectTarget(rawTarget);
  if (!parsed) {
    return undefined;
  }
  return `user:${parsed.userId}${parsed.accountId ? `@${parsed.accountId}` : ''}`;
}

export function parseWecomAppDirectTarget(
  rawTarget: string,
): { accountId?: string; userId: string } | null {
  let raw = String(rawTarget ?? '').trim();
  if (!raw) {
    return null;
  }

  if (raw.startsWith('wecom-app:')) {
    raw = raw.slice('wecom-app:'.length);
  }

  let accountId: string | undefined;
  if (!looksLikeEmail(raw)) {
    const atIndex = raw.lastIndexOf('@');
    if (atIndex > 0 && atIndex < raw.length - 1) {
      const candidate = raw.slice(atIndex + 1);
      if (!/[:/]/.test(candidate)) {
        accountId = candidate;
        raw = raw.slice(0, atIndex);
      }
    }
  }

  if (raw.startsWith('group:')) {
    return null;
  }

  const explicitUserPrefix = raw.startsWith('user:');
  if (explicitUserPrefix) {
    raw = raw.slice('user:'.length);
  }

  const userId = raw.trim();
  if (!userId || /\s/.test(userId)) {
    return null;
  }
  if (!explicitUserPrefix && !BARE_USER_ID_RE.test(userId)) {
    return null;
  }
  if (explicitUserPrefix && !EXPLICIT_USER_ID_RE.test(userId)) {
    return null;
  }

  return { accountId, userId };
}

export function parseWecomAppJid(
  jid: string,
): { kind: 'user'; id: string; accountId?: string } | { kind: 'group'; id: string } | null {
  if (jid.startsWith('wecom-app:user:')) {
    const parsed = parseWecomAppDirectTarget(jid);
    if (!parsed) {
      return null;
    }
    return { kind: 'user', id: parsed.userId, accountId: parsed.accountId };
  }
  if (jid.startsWith('wecom-app:group:')) {
    return { kind: 'group', id: jid.slice('wecom-app:group:'.length) };
  }
  return null;
}

export function resolveWecomAppTarget(
  rawTarget: string,
  conversationId?: ConversationId,
): MessageTarget | null {
  const parsedJid = parseWecomAppJid(rawTarget);
  if (parsedJid) {
    const chatJid =
      parsedJid.kind === 'group'
        ? `wecom-app:group:${parsedJid.id}`
        : `wecom-app:user:${parsedJid.id}${parsedJid.accountId ? `@${parsedJid.accountId}` : ''}`;
    return {
      conversationId: conversationId || `conv:${chatJid}`,
      chatJid,
      channel: 'wecom-app',
      externalId: parsedJid.id,
      peerKind: parsedJid.kind,
      accountId: parsedJid.kind === 'user' ? parsedJid.accountId : undefined,
      isGroup: parsedJid.kind === 'group',
    };
  }

  const parsedDirect = parseWecomAppDirectTarget(rawTarget);
  if (!parsedDirect) {
    return null;
  }

  const chatJid = `wecom-app:user:${parsedDirect.userId}${parsedDirect.accountId ? `@${parsedDirect.accountId}` : ''}`;
  return {
    conversationId: conversationId || `conv:${chatJid}`,
    chatJid,
    channel: 'wecom-app',
    externalId: parsedDirect.userId,
    peerKind: 'user',
    accountId: parsedDirect.accountId,
    isGroup: false,
  };
}

export async function sendWecomAppMessage(
  config: WecomAppConfig,
  target: MessageTarget,
  text: string,
): Promise<void> {
  logger.info(
    {
      chatJid: target.chatJid,
      textLength: text.length,
      textPreview: text.slice(0, 200),
    },
    'Sending WeCom message',
  );
  if (target.channel !== 'wecom-app') {
    throw new Error(`Unsupported WeCom target channel: ${target.channel}`);
  }
  if (target.peerKind !== 'user' && target.peerKind !== 'group') {
    throw new Error(`Unsupported WeCom target kind: ${target.peerKind}`);
  }

  const accessToken = await getAccessToken(config);
  const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/message/send');
  url.searchParams.set('access_token', accessToken);

  const cleanText = stripMarkdown(text);
  const parts = splitText(cleanText, 1800).filter(
    (part) => part.trim().length > 0,
  );

  logger.info({ chatJid: target.chatJid, parts: parts.length }, 'Prepared WeCom outbound message parts');

  for (const part of parts) {
    const body: Record<string, unknown> = {
      msgtype: 'text',
      agentid: config.agentId,
      text: { content: part },
      safe: 0,
      enable_id_trans: 0,
      enable_duplicate_check: 0,
    };

    if (target.peerKind === 'group') {
      body.chatid = target.externalId;
    } else {
      body.touser = target.externalId;
    }

    logger.info(
      {
        chatJid: target.chatJid,
        targetKind: target.peerKind,
        targetId: target.externalId,
        accountId: target.accountId,
        bodyPreview: JSON.stringify(body).slice(0, 300),
      },
      'Posting WeCom outbound message',
    );

    const response = await fetchWecom(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`WeCom send failed: ${response.status}`);
    }

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object') {
      throw new Error('WeCom send returned invalid payload');
    }
    const result = payload as { errcode?: unknown; errmsg?: unknown };
    logger.info({ result }, 'WeCom outbound message API responded');
    if (result.errcode !== 0) {
      throw new Error(
        `WeCom send failed: ${String(result.errmsg ?? result.errcode)}`,
      );
    }
  }

  logger.info({ chatJid: target.chatJid }, 'WeCom message sent successfully');
}
