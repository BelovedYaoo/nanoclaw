export interface TriggerPolicyMessage {
  sender: string;
  is_from_me?: boolean;
  trigger_matched?: boolean;
}

export function hasMatchedTriggerMessage(
  messages: TriggerPolicyMessage[],
  isSenderTriggerAllowed: (message: TriggerPolicyMessage) => boolean,
): boolean {
  return messages.some(
    (message) =>
      message.trigger_matched === true &&
      (message.is_from_me === true || isSenderTriggerAllowed(message)),
  );
}

export function shouldDispatchForMessages(
  route: { isMain: boolean; requiresTrigger: boolean },
  messages: TriggerPolicyMessage[],
  isSenderTriggerAllowed: (message: TriggerPolicyMessage) => boolean,
): boolean {
  if (route.isMain || route.requiresTrigger === false) {
    return true;
  }

  return hasMatchedTriggerMessage(messages, isSenderTriggerAllowed);
}
