// ---------------------------------------------------------------------------
// Feishu Types — Event schema fragments, token responses, IM message types
// ---------------------------------------------------------------------------

/** Feishu tenant_access_token response */
export interface FeishuTenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number;
}

/** Payload sent to send a message */
export interface FeishuSendMessagePayload {
  receive_id: string;
  msg_type: string;
  content: string;
}

/** Response from sending a message */
export interface FeishuSendMessageResponse {
  code: number;
  msg: string;
  data?: {
    message_id: string;
  };
}

/** Header of a feishu event v2 frame */
export interface FeishuEventHeader {
  event_id: string;
  event_type: string;
  create_time: string;
  token: string;
  app_id: string;
  tenant_key?: string;
}

/** A full feishu event frame delivered over the long connection */
export interface FeishuEventFrame {
  type: string;
  header?: FeishuEventHeader;
  payload?: unknown;
  data?: unknown;
  raw?: string;
}

/** Parsed receive message event payload */
export interface FeishuReceivedMessage {
  chatId: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  text: string;
  raw: unknown;
}

/** Long-connection endpoint response */
export interface FeishuEndpointResponse {
  code: number;
  msg: string;
  data: {
    URL: string;
    conn_id?: string;
    expires_in?: number;
  };
}

/** IM message types supported for outbound */
export type FeishuMsgType = 'text' | 'interactive' | 'post';
