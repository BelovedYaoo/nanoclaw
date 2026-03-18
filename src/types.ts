export type ChannelId = string;
export type AccountId = string;
export type ConversationId = string;

export type ConversationPeerKind = 'group' | 'user' | 'system' | 'legacy';

export interface ConversationRef {
  channel: ChannelId;
  externalId: string;
  peerKind: ConversationPeerKind;
  accountId?: AccountId;
}

export interface ConversationRecord extends ConversationRef {
  id: ConversationId;
  legacyChatJid?: string;
  displayName: string;
  isGroup: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MessageTarget {
  conversationId: ConversationId;
  chatJid: string;
  channel: ChannelId;
  externalId: string;
  peerKind: ConversationPeerKind;
  accountId?: AccountId;
  isGroup: boolean;
}

export interface RegisteredConversation {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger?: boolean;
  isMain?: boolean;
  conversationId?: ConversationId;
}

/** @deprecated 使用 RegisteredConversation */
export type RegisteredGroup = RegisteredConversation;

export interface NewMessage {
  id: string;
  chat_jid: string;
  conversation_id?: ConversationId;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  message_type?: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  mentioned_bot?: boolean;
  trigger_matched?: boolean;
  trigger_source?: 'mention' | 'text' | 'system' | 'none';
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  conversation_id?: ConversationId;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(target: MessageTarget, text: string): Promise<void>;
  isConnected(): boolean;
  ownsTarget(target: MessageTarget): boolean;
  disconnect(): Promise<void>;
  normalizeTarget?(target: string): string | undefined;
  resolveTarget?(target: string, conversationId?: ConversationId): MessageTarget | null;
  getTargetFormats?(): string[];
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(target: MessageTarget, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
