import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  AgentRuntimeOutput,
  AvailableGroup,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './agent-runtime.js';
import { AdminApiService } from './admin-api.js';
import { runHostAgent } from './host-agent-runner.js';
import {
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRouterState,
  setSession,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { formatMessages } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredConversation } from './types.js';
import { logger } from './logger.js';
import { ConversationService } from './services/conversation-service.js';
import { RegistrationService } from './services/registration-service.js';
import { ReplyDispatchService } from './services/reply-dispatch-service.js';
import { SessionRouteService } from './services/session-route-service.js';
import { shouldDispatchForMessages } from './services/trigger-policy-service.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredConversation> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
const replyDispatchService = new ReplyDispatchService(() => channels);
const conversationService = new ConversationService((target, conversationId) =>
  replyDispatchService.resolveTarget(target, conversationId),
);
const registrationService = new RegistrationService();
const sessionRouteService = new SessionRouteService(
  conversationService,
  registrationService,
  () => sessions,
  (nextSessions) => {
    sessions = nextSessions;
  },
);

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = registrationService.getAll();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredConversation): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  const target = conversationService.getTarget(jid, group.conversationId);
  const registeredGroup: RegisteredConversation = {
    ...group,
    conversationId: target.conversationId,
  };

  registeredGroups[jid] = registeredGroup;
  registrationService.set(jid, registeredGroup, target);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    {
      jid,
      name: registeredGroup.name,
      folder: registeredGroup.folder,
      conversationId: registeredGroup.conversationId,
    },
    'Group registered',
  );
}

function getAutoRegistrationInfo(chatJid: string): {
  channel: string;
  isGroupChat: boolean;
  peerLabel: string;
  externalId: string;
} {
  const parts = chatJid.split(':');
  const channel = parts[0] || 'legacy';
  const peerKind = parts[1] || 'legacy';
  const externalId = parts.slice(2).join(':') || chatJid;
  const isGroupChat = peerKind === 'group';

  return {
    channel,
    isGroupChat,
    peerLabel: isGroupChat ? 'group' : peerKind === 'user' ? 'user' : 'chat',
    externalId,
  };
}

function buildAutoRegisteredFolder(chatJid: string, isGroupChat: boolean): string {
  const info = getAutoRegistrationInfo(chatJid);
  const channelPrefix = info.channel.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  const peerPrefix = isGroupChat ? 'group' : 'user';
  const suffix = info.externalId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

  return `${channelPrefix}_${peerPrefix}_${suffix || 'chat'}`;
}

function autoRegisterChat(chatJid: string, msg: NewMessage): void {
  if (registeredGroups[chatJid]) {
    return;
  }

  const info = getAutoRegistrationInfo(chatJid);
  if (info.channel === 'legacy') {
    return;
  }

  const isFirstRegisteredGroup = Object.keys(registeredGroups).length === 0;
  const displayChannel = info.channel
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  const group: RegisteredConversation = {
    name: `${displayChannel} ${info.peerLabel} ${msg.sender_name}`,
    folder: buildAutoRegisteredFolder(chatJid, info.isGroupChat),
    trigger: `@${ASSISTANT_NAME}`,
    added_at: msg.timestamp,
    requiresTrigger: info.isGroupChat,
    isMain: !info.isGroupChat && isFirstRegisteredGroup,
  };

  registerGroup(chatJid, group);
  logger.info(
    {
      chatJid,
      channel: info.channel,
      folder: group.folder,
      isMain: group.isMain === true,
      requiresTrigger: group.requiresTrigger === true,
    },
    'Auto-registered chat',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): AvailableGroup[] {
  const chats = conversationService.listChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredConversation>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = sessionRouteService.getRegisteredGroupByJid(
    chatJid,
    registeredGroups,
  );
  if (!group) return true;

  const channel = replyDispatchService.getChannel(chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  if (
    !shouldDispatchForMessages(
      {
        isMain: group.isMain === true,
        requiresTrigger: group.requiresTrigger !== false,
      },
      missedMessages,
      (message) => {
        const allowlistCfg = loadSenderAllowlist();
        return isTriggerAllowed(chatJid, message.sender, allowlistCfg);
      },
    )
  ) {
    return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing host agent stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await replyDispatchService.setTyping(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
        if (text) {
          const sent = await replyDispatchService.send(chatJid, text);
          outputSentToUser = sent;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await replyDispatchService.setTyping(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredConversation,
  prompt: string,
  chatJid: string,
  onOutput?: (output: AgentRuntimeOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const route = sessionRouteService.resolveAgentRoute(chatJid);
  const isMain = route.isMain;
  const sessionId = sessionRouteService.getSessionId(group.folder);
  const target = route.target;

  // Update tasks snapshot for host agent to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
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

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: AgentRuntimeOutput) => {
        if (output.newSessionId) {
          sessionRouteService.recordSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runHostAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        conversationId: target.conversationId,
        target,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, processName) =>
        queue.registerProcess(chatJid, proc, processName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessionRouteService.recordSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Host agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info('NanoClaw running with channel-normalized triggers');

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = sessionRouteService.getRegisteredGroupByJid(
            chatJid,
            registeredGroups,
          );
          if (!group) {
            logger.info({ chatJid }, 'Skipping message loop processing because chat is not registered');
            continue;
          }

          const channel = replyDispatchService.getChannel(chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          if (
            !shouldDispatchForMessages(
              {
                isMain: group.isMain === true,
                requiresTrigger: group.requiresTrigger !== false,
              },
              groupMessages,
              (message) => {
                const allowlistCfg = loadSenderAllowlist();
                return isTriggerAllowed(chatJid, message.sender, allowlistCfg);
              },
            )
          ) {
            continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);
          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active host agent',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the host agent processes the piped message
            replyDispatchService
              .setTyping(chatJid, true)
              .catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active host agent — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  let adminApi: AdminApiService | null = null;

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await adminApi?.stop();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      autoRegisterChat(chatJid, msg);

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(conversationService.getTarget(chatJid, msg.conversation_id), msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => {
      conversationService.recordChatMetadata(
        chatJid,
        timestamp,
        name,
        channel,
        isGroup,
      );
    },
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  logger.info(
    { channels: channels.map((channel) => channel.name) },
    'Channels connected',
  );

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    resolveTarget: (target, conversationId) =>
      replyDispatchService.resolveTarget(target, conversationId),
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (target, proc, processName, groupFolder) =>
      queue.registerProcess(target.chatJid, proc, processName, groupFolder),
    sendMessage: async (target, rawText) => {
      const sent = await replyDispatchService.send(target, rawText);
      if (!sent) {
        logger.warn(
          { chatJid: target.chatJid, conversationId: target.conversationId },
          'No channel owns target, cannot send message',
        );
      }
    },
  });
  const syncGroups = async (force: boolean) => {
    await Promise.all(
      channels
        .filter((ch) => ch.syncGroups)
        .map((ch) => ch.syncGroups!(force)),
    );
  };

  startIpcWatcher({
    resolveTarget: (target, conversationId) =>
      replyDispatchService.resolveTarget(target, conversationId),
    sendMessage: async (target, text) => {
      const sent = await replyDispatchService.send(target, text);
      if (!sent) {
        throw new Error(`No channel for target: ${target.chatJid}`);
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups,
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });

  adminApi = new AdminApiService({
    getAvailableGroups,
    registeredGroups: () => registeredGroups,
    syncGroups,
  });
  await adminApi.start();

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
