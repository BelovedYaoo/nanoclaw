import path from 'path';

import { setSession } from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { MessageTarget, RegisteredConversation } from '../types.js';
import { ConversationService } from './conversation-service.js';
import { RegistrationService, RegisteredConversationEntry } from './registration-service.js';

export class SessionRouteService {
  constructor(
    private readonly conversationService: ConversationService,
    private readonly registrationService: RegistrationService,
    private readonly getSessions: () => Record<string, string>,
    private readonly setSessionsState: (sessions: Record<string, string>) => void,
  ) {}

  getTarget(chatJid: string, conversationId?: string): MessageTarget {
    return this.conversationService.getTarget(chatJid, conversationId);
  }

  getRegisteredGroupByJid(
    chatJid: string,
    groups?: Record<string, RegisteredConversation>,
  ): RegisteredConversationEntry | undefined {
    const source = groups || this.registrationService.getAll();
    const group = source[chatJid];
    return group ? { jid: chatJid, ...group } : undefined;
  }

  getRegisteredGroupByFolder(
    folder: string,
    groups?: Record<string, RegisteredConversation>,
  ): RegisteredConversationEntry | undefined {
    if (groups) {
      return this.registrationService.findByFolder(folder, groups);
    }
    return this.registrationService.getByFolder(folder);
  }

  resolveRegisteredTarget(
    chatJid: string,
    groups?: Record<string, RegisteredConversation>,
  ): { target: MessageTarget; group?: RegisteredConversationEntry } {
    const group = this.getRegisteredGroupByJid(chatJid, groups);
    const target = this.conversationService.getTarget(chatJid, group?.conversationId);
    return { target, group };
  }

  resolveAgentRoute(
    chatJid: string,
    groups?: Record<string, RegisteredConversation>,
  ): {
    target: MessageTarget;
    groupFolder?: string;
    isMain: boolean;
    requiresTrigger: boolean;
  } {
    const resolved = this.resolveRegisteredTarget(chatJid, groups);
    return {
      target: resolved.target,
      groupFolder: resolved.group?.folder,
      isMain: resolved.group?.isMain === true,
      requiresTrigger: resolved.group?.requiresTrigger !== false,
    };
  }

  getSessionId(groupFolder: string): string | undefined {
    return this.getSessions()[groupFolder];
  }

  resolveStorePath(groupFolder: string): string {
    return path.join(resolveGroupFolderPath(groupFolder), 'store');
  }

  readSessionUpdatedAt(groupFolder: string): string | null {
    const sessionId = this.getSessions()[groupFolder];
    return sessionId ? new Date().toISOString() : null;
  }

  recordSession(groupFolder: string, sessionId: string): void {
    const current = this.getSessions();
    this.setSessionsState({
      ...current,
      [groupFolder]: sessionId,
    });
    setSession(groupFolder, sessionId);
  }
}
