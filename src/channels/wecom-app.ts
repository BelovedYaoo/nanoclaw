import { registerChannel } from './registry.js';
import { Channel, ConversationId, MessageTarget, NewMessage } from '../types.js';
import {
  loadWecomAppConfig,
  normalizeWecomAppTarget,
  resolveWecomAppTarget,
  sendWecomAppMessage,
  WecomAppConfig,
  WecomAppInboundEnvelope,
  WecomAppService,
} from '../wecom-app.js';
import { logger } from '../logger.js';

class WecomAppChannel implements Channel {
  name = 'wecom-app';

  private readonly config: WecomAppConfig;
  private readonly service: WecomAppService;
  private connected = false;

  constructor(
    config: WecomAppConfig,
    onInbound: (payload: WecomAppInboundEnvelope) => void,
  ) {
    this.config = config;
    this.service = new WecomAppService({
      config,
      onMessage: onInbound,
    });
  }

  async connect(): Promise<void> {
    await this.service.start();
    this.connected = true;
  }

  async sendMessage(target: MessageTarget, text: string): Promise<void> {
    await sendWecomAppMessage(this.config, target, text);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsTarget(target: MessageTarget): boolean {
    return target.channel === 'wecom-app';
  }

  normalizeTarget(target: string): string | undefined {
    return normalizeWecomAppTarget(target);
  }

  resolveTarget(target: string, conversationId?: ConversationId): MessageTarget | null {
    return resolveWecomAppTarget(target, conversationId);
  }

  getTargetFormats(): string[] {
    return ['wecom-app:user:<userId>', 'user:<userId>', '<userid-lowercase>'];
  }

  async disconnect(): Promise<void> {
    await this.service.stop();
    this.connected = false;
  }
}

registerChannel('wecom-app', (opts) => {
  const config = loadWecomAppConfig();
  if (!config) {
    return null;
  }

  return new WecomAppChannel(config, (payload) => {
    opts.onChatMetadata(
      payload.chatJid,
      payload.message.timestamp,
      payload.chatName,
      'wecom-app',
      payload.isGroup,
    );

    const message: NewMessage = payload.message;
    logger.debug(
      {
        chatJid: payload.chatJid,
        sender: message.sender,
      },
      'Received WeCom message',
    );
    opts.onMessage(payload.chatJid, message);
  });
});
