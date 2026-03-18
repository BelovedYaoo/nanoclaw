import { Channel, ConversationId, MessageTarget, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

function splitAccountScopedExternalId(
  channel: string,
  peerKind: 'group' | 'user' | 'system' | 'legacy',
  rawExternalId: string,
): { externalId: string; accountId?: string } {
  if (channel !== 'wecom-app' || peerKind !== 'user') {
    return { externalId: rawExternalId };
  }

  const atIndex = rawExternalId.lastIndexOf('@');
  if (atIndex <= 0 || atIndex >= rawExternalId.length - 1) {
    return { externalId: rawExternalId };
  }

  const externalId = rawExternalId.slice(0, atIndex);
  const accountId = rawExternalId.slice(atIndex + 1);
  if (!externalId || !accountId || /[:/]/.test(accountId)) {
    return { externalId: rawExternalId };
  }

  return { externalId, accountId };
}

export function resolveMessageTarget(chatJid: string, conversationId?: string): MessageTarget {
  const parts = chatJid.split(':');
  const channel = parts[0] || 'legacy';
  const peerKind =
    chatJid === '__group_sync__'
      ? 'system'
      : parts[1] === 'group'
        ? 'group'
        : parts[1] === 'user'
          ? 'user'
          : 'legacy';
  const rawExternalId = parts.length > 2 ? parts.slice(2).join(':') : chatJid;
  const targetIdentity = splitAccountScopedExternalId(channel, peerKind, rawExternalId);

  return {
    conversationId: conversationId || `conv:${chatJid}`,
    chatJid,
    channel,
    externalId: targetIdentity.externalId,
    peerKind,
    accountId: targetIdentity.accountId,
    isGroup: peerKind === 'group',
  };
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function resolveChannelTarget(
  channels: Channel[],
  target: string,
  conversationId?: ConversationId,
): MessageTarget {
  for (const channel of channels) {
    const resolvedTarget = channel.resolveTarget?.(target, conversationId);
    if (resolvedTarget) {
      return resolvedTarget;
    }
  }
  return resolveMessageTarget(target, conversationId);
}

export function routeOutbound(
  channels: Channel[],
  target: MessageTarget | string,
  text: string,
): Promise<void> {
  const resolvedTarget =
    typeof target === 'string' ? resolveChannelTarget(channels, target) : target;
  const channel = channels.find(
    (entry) => entry.ownsTarget(resolvedTarget) && entry.isConnected(),
  );
  if (!channel) {
    throw new Error(`No channel for target: ${resolvedTarget.chatJid}`);
  }
  return channel.sendMessage(resolvedTarget, text);
}

export function findChannel(
  channels: Channel[],
  target: MessageTarget | string,
): Channel | undefined {
  const resolvedTarget =
    typeof target === 'string' ? resolveChannelTarget(channels, target) : target;
  return channels.find((entry) => entry.ownsTarget(resolvedTarget));
}
