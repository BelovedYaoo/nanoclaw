import {
  ChatInfo,
  getAllChats,
  getChatByJid,
  storeChatMetadata,
  updateChatName,
} from '../db.js';
import { ConversationId, MessageTarget } from '../types.js';

export interface ConversationSummary {
  conversationId: string;
  chatJid: string;
  name: string;
  lastActivity: string;
  channel: string;
  isGroup: boolean;
}

export class ConversationService {
  constructor(
    private readonly resolveTarget: (
      target: string,
      conversationId?: ConversationId,
    ) => MessageTarget,
  ) {}

  getTarget(chatJid: string, conversationId?: string): MessageTarget {
    const chat = getChatByJid(chatJid);
    return this.resolveTarget(chatJid, conversationId || chat?.conversation_id);
  }

  recordChatMetadata(
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ): MessageTarget {
    const target = this.resolveTarget(chatJid);
    storeChatMetadata(
      {
        ...target,
        channel: channel || target.channel,
        isGroup: isGroup === true ? true : target.isGroup,
        peerKind:
          isGroup === true && target.peerKind !== 'group' ? 'group' : target.peerKind,
      },
      timestamp,
      name,
    );
    return this.getTarget(chatJid);
  }

  renameChat(chatJid: string, name: string): MessageTarget {
    const target = this.getTarget(chatJid);
    updateChatName(target, name);
    return this.getTarget(chatJid);
  }

  getChat(chatJid: string): ChatInfo | undefined {
    return getChatByJid(chatJid);
  }

  listChats(): ChatInfo[] {
    return getAllChats();
  }

  listConversationSummaries(): ConversationSummary[] {
    return this.listChats().map((chat) => ({
      conversationId: chat.conversation_id,
      chatJid: chat.jid,
      name: chat.name,
      lastActivity: chat.last_message_time,
      channel: chat.channel,
      isGroup: chat.is_group === 1,
    }));
  }
}
