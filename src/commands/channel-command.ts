// ---------------------------------------------------------------------------
// /channel command — manage external channels from CLI / dispatcher.
//
// Subcommands: list | add | remove | test | start | stop | status
// ---------------------------------------------------------------------------

import { successResult, failureResult, type CommandResult } from '../shared/result.js';
import type { ChannelConfig, ChannelKind } from '../channel/channel-types.js';
import {
  deleteChannelConfig,
  loadChannelsConfig,
  upsertChannelConfig,
} from '../channel/channel-config.js';
import { ChannelService } from '../channel/channel-service.js';

export interface ChannelCommandDependencies {
  readonly channelService: ChannelService;
  /** Set the channel appSecret credential (target = pueblo:feishu:<id>) */
  readonly setCredential?: (target: string, secret: string) => void;
}

const USAGE = [
  'Usage:',
  '  /channel list                         List configured channels',
  '  /channel add <id> <kind> <name> [optionsJson]  Add/update a channel',
  '  /channel remove <id>                  Remove a channel',
  '  /channel test <id>                    Test a channel connection',
  '  /channel start <id>                   Start a channel',
  '  /channel stop <id>                    Stop a channel',
  '  /channel status                       Show running channel statuses',
  '  /channel secret <id> <appSecret>      Store the channel app secret',
].join('\n');

const SUPPORTED_KINDS: ChannelKind[] = ['feishu'];

export function createChannelCommand(deps: ChannelCommandDependencies) {
  return async (args: string[]): Promise<CommandResult<unknown>> => {
    const subcommand = args[0];

    switch (subcommand) {
      case 'list':
        return listChannels();
      case 'add':
        return addChannel(args.slice(1));
      case 'remove':
        return removeChannel(args.slice(1));
      case 'test':
        return testChannel(args.slice(1));
      case 'start':
        return startChannel(args.slice(1), deps);
      case 'stop':
        return stopChannel(args.slice(1), deps);
      case 'status':
        return channelStatus(deps);
      case 'secret':
        return setSecret(args.slice(1), deps);
      default:
        return failureResult('INVALID_USAGE', `Unknown /channel subcommand "${subcommand ?? ''}"`, [USAGE]);
    }
  };
}

function buildConfigFromArgs(args: string[]): ChannelConfig | { error: string } {
  const [id, kind, name, optionsJson] = args;
  if (!id || !kind || !name) {
    return { error: 'Usage: /channel add <id> <kind> <name> [optionsJson]' };
  }
  if (!SUPPORTED_KINDS.includes(kind as ChannelKind)) {
    return { error: `Unsupported channel kind "${kind}". Supported: ${SUPPORTED_KINDS.join(', ')}` };
  }

  let options: Record<string, unknown> = {};
  if (optionsJson) {
    try {
      const parsed = JSON.parse(optionsJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        options = parsed as Record<string, unknown>;
      } else {
        return { error: 'optionsJson must be a JSON object' };
      }
    } catch {
      return { error: 'optionsJson is not valid JSON' };
    }
  }

  return {
    id,
    kind: kind as ChannelKind,
    name,
    enabled: true,
    transport: 'long-connection',
    options,
    credentialTarget: `pueblo:feishu:${id}`,
    source: 'manual',
  };
}

async function listChannels(): Promise<CommandResult<unknown>> {
  const config = await loadChannelsConfig();
  return successResult('CHANNEL_LIST', `Configured channels (${config.channels.length})`, {
    channels: config.channels,
  });
}

async function addChannel(args: string[]): Promise<CommandResult<unknown>> {
  const built = buildConfigFromArgs(args);
  if ('error' in built) {
    return failureResult('INVALID_USAGE', built.error, [USAGE]);
  }
  await upsertChannelConfig(built);
  return successResult('CHANNEL_SAVED', `Channel "${built.id}" saved`, { channel: built });
}

async function removeChannel(args: string[]): Promise<CommandResult<unknown>> {
  const id = args[0];
  if (!id) return failureResult('INVALID_USAGE', 'Usage: /channel remove <id>', [USAGE]);
  const removed = await deleteChannelConfig(id);
  if (!removed) return failureResult('CHANNEL_NOT_FOUND', `Channel "${id}" not found`);
  return successResult('CHANNEL_REMOVED', `Channel "${id}" removed`);
}

async function testChannel(args: string[]): Promise<CommandResult<unknown>> {
  const id = args[0];
  if (!id) return failureResult('INVALID_USAGE', 'Usage: /channel test <id>', [USAGE]);
  return failureResult('CHANNEL_TEST_UNAVAILABLE', 'Channel testing requires a running ChannelService with adapter access');
}

async function startChannel(args: string[], deps: ChannelCommandDependencies): Promise<CommandResult<unknown>> {
  const id = args[0];
  if (!id) return failureResult('INVALID_USAGE', 'Usage: /channel start <id>', [USAGE]);
  const config = await loadChannelsConfig();
  const target = config.channels.find((c) => c.id === id);
  if (!target) return failureResult('CHANNEL_NOT_FOUND', `Channel "${id}" not found`);
  try {
    await deps.channelService.startChannel(target);
    return successResult('CHANNEL_STARTED', `Channel "${id}" started`);
  } catch (err) {
    return failureResult('CHANNEL_START_FAILED', err instanceof Error ? err.message : String(err));
  }
}

async function stopChannel(args: string[], deps: ChannelCommandDependencies): Promise<CommandResult<unknown>> {
  const id = args[0];
  if (!id) return failureResult('INVALID_USAGE', 'Usage: /channel stop <id>', [USAGE]);
  const stopped = await deps.channelService.stopChannel(id);
  if (!stopped) return failureResult('CHANNEL_NOT_RUNNING', `Channel "${id}" is not running`);
  return successResult('CHANNEL_STOPPED', `Channel "${id}" stopped`);
}

async function channelStatus(deps: ChannelCommandDependencies): Promise<CommandResult<unknown>> {
  const states = deps.channelService.getStatus();
  return successResult('CHANNEL_STATUS', `Running channels (${states.length})`, { states });
}

function setSecret(args: string[], deps: ChannelCommandDependencies): CommandResult<unknown> {
  const id = args[0];
  const secret = args.slice(1).join(' ');
  if (!id || !secret) return failureResult('INVALID_USAGE', 'Usage: /channel secret <id> <appSecret>', [USAGE]);
  if (!deps.setCredential) {
    return failureResult('CREDENTIAL_STORE_UNAVAILABLE', 'No credential store wired for this runtime');
  }
  try {
    deps.setCredential(`pueblo:feishu:${id}`, secret);
    return successResult('CHANNEL_SECRET_SET', `Stored secret for channel "${id}"`);
  } catch (err) {
    return failureResult('CHANNEL_SECRET_FAILED', err instanceof Error ? err.message : String(err));
  }
}
