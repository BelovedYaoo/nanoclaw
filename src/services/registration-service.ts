import {
  getAllRegisteredGroups,
  getRegisteredGroup,
  getRegisteredGroupByFolder,
  setRegisteredGroup,
} from '../db.js';
import { MessageTarget, RegisteredConversation } from '../types.js';

export interface RegisteredConversationEntry extends RegisteredConversation {
  jid: string;
}

export class RegistrationService {
  getAll(): Record<string, RegisteredConversation> {
    return getAllRegisteredGroups();
  }

  getByJid(jid: string): RegisteredConversationEntry | undefined {
    return getRegisteredGroup(jid);
  }

  getByFolder(folder: string): RegisteredConversationEntry | undefined {
    return getRegisteredGroupByFolder(folder);
  }

  set(jid: string, conversation: RegisteredConversation, target: MessageTarget): void {
    setRegisteredGroup(jid, conversation, target);
  }

  findByFolder(folder: string, groups?: Record<string, RegisteredConversation>): RegisteredConversationEntry | undefined {
    const source = groups || getAllRegisteredGroups();
    for (const [jid, group] of Object.entries(source)) {
      if (group.folder === folder) {
        return { jid, ...group };
      }
    }
    return undefined;
  }
}
