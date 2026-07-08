/**
 * Channel debug logger — wraps the unified Logger with backward-compatible
 * function signature.
 *
 * Output directory: .logs/channel/  (daily-rolled).
 */

import { channelLogger } from '../utils/logger.js';

export function channelDebugLog(message: string, ..._args: unknown[]): void {
  channelLogger.info(message);
}
