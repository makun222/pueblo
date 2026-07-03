// ---------------------------------------------------------------------------
// Feishu Config — zod schema for feishu-specific channel options
// ---------------------------------------------------------------------------

import { z } from 'zod';

export const feishuOptionsSchema = z.object({
  appId: z.string().min(1),
  /** Optional encryption key for event payload decryption */
  encryptKey: z.string().optional(),
  /** Verification token echoed by feishu during event validation */
  verificationToken: z.string().optional(),
  /** Override the long-connection endpoint discovery base url */
  endpointUrl: z.string().url().optional(),
  /** Override the IM / open-apis base url */
  imApiBaseUrl: z.string().url().optional(),
});

export type FeishuOptions = z.infer<typeof feishuOptionsSchema>;

export const DEFAULT_IM_API_BASE_URL = 'https://open.feishu.cn/open-apis';
export const DEFAULT_ENDPOINT_DISCOVERY_PATH = '/callback/event/v1/connect';

/** Parse & validate feishu options from a raw record */
export function parseFeishuOptions(options: Record<string, unknown>): FeishuOptions {
  return feishuOptionsSchema.parse(options);
}

/** Safely parse feishu options, returning null on validation failure */
export function safeParseFeishuOptions(options: Record<string, unknown>): FeishuOptions | null {
  const result = feishuOptionsSchema.safeParse(options);
  return result.success ? result.data : null;
}
