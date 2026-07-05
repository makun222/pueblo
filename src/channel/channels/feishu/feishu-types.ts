// ---------------------------------------------------------------------------
// Feishu Types — shared message types used by the feishu channel adapter
// ---------------------------------------------------------------------------

/** Parsed receive message event payload */
export interface FeishuReceivedMessage {
  chatId: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  text: string;
  raw: unknown;
}
