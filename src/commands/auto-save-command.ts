import { successResult, failureResult } from '../shared/result.js';
import { isAutoSaveEnabled, setAutoSaveEnabled } from '../shared/auto-save-state.js';

/**
 * Factory that creates the /auto-save command handler.
 *
 * Usage: /auto-save on|off
 */
export function createAutoSaveHandler() {
  return (args: string[]) => {
    if (args.length !== 1 || !['on', 'off'].includes(args[0])) {
      return failureResult(
        'INVALID_USAGE',
        'Usage: /auto-save on|off',
        ['Provide exactly one argument: "on" or "off".'],
      );
    }

    const enable = args[0] === 'on';
    setAutoSaveEnabled(enable);

    const status = isAutoSaveEnabled() ? 'enabled' : 'disabled';
    return successResult('AUTO_SAVE_TOGGLED', `Auto-save ${status}.`);
  };
}
