import { findChannel, formatOutbound, resolveChannelTarget } from '../router.js';
import { Channel, ConversationId, MessageTarget } from '../types.js';

export class ReplyDispatchService {
  constructor(private readonly getChannels: () => Channel[]) {}

  resolveTarget(target: MessageTarget | string, conversationId?: ConversationId): MessageTarget {
    return typeof target === 'string'
      ? resolveChannelTarget(this.getChannels(), target, conversationId)
      : target;
  }

  getChannel(target: MessageTarget | string): Channel | undefined {
    return findChannel(this.getChannels(), target);
  }

  async send(
    target: MessageTarget | string,
    rawText: string,
    conversationId?: ConversationId,
  ): Promise<boolean> {
    const resolvedTarget = this.resolveTarget(target, conversationId);
    const channel = this.getChannel(resolvedTarget);
    if (!channel) {
      return false;
    }
    const text = formatOutbound(rawText);
    if (!text) {
      return true;
    }
    await channel.sendMessage(resolvedTarget, text);
    return true;
  }

  async setTyping(
    target: MessageTarget | string,
    isTyping: boolean,
    conversationId?: ConversationId,
  ): Promise<boolean> {
    const resolvedTarget = this.resolveTarget(target, conversationId);
    const channel = this.getChannel(resolvedTarget);
    if (!channel?.setTyping) {
      return false;
    }
    await channel.setTyping(resolvedTarget, isTyping);
    return true;
  }
}
