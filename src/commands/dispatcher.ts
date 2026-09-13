import { failureResult, successResult, type CommandResult } from '../shared/result';
import { createAutoSaveHandler } from './auto-save-command.js';
import { createUndoHandler } from './undo-command.js';
import { createChannelCommand } from './channel-command.js';
import type { ChannelService } from '../channel/channel-service.js';

export interface DispatchRequest {
  readonly input: string;
}

export type CommandHandler = (args: string[]) => CommandResult<unknown> | Promise<CommandResult<unknown>>;

export class CommandDispatcher {
  private readonly handlers = new Map<string, CommandHandler>();

  register(commandName: string, handler: CommandHandler): void {
    this.handlers.set(commandName, handler);
  }

  hasCommand(commandName: string): boolean {
    return this.handlers.has(commandName);
  }

  listCommands(): string[] {
    return [...this.handlers.keys()].sort((left, right) => left.localeCompare(right));
  }

  async dispatch(request: DispatchRequest): Promise<CommandResult> {
    const trimmed = request.input.trim();

    if (!trimmed.startsWith('/')) {
      return failureResult('INVALID_COMMAND', 'Commands must start with /', ['Use a supported slash command.']);
    }

    const tokens = tokenizeCommandInput(trimmed);

    if (tokens.length === 0) {
      return failureResult('INVALID_COMMAND', 'Commands must start with /', ['Use a supported slash command.']);
    }

    const [commandName, ...args] = tokens;
    const handler = this.handlers.get(commandName);

    if (!handler) {
      return failureResult('UNKNOWN_COMMAND', `Unsupported command: ${commandName}`, [
        'Use /help to list available commands.',
      ]);
    }

    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof Error) {
        return failureResult('COMMAND_EXECUTION_FAILED', error.message, ['Inspect the command arguments and retry.']);
      }

      return failureResult('COMMAND_EXECUTION_FAILED', 'Command execution failed', [
        'Inspect the command arguments and retry.',
      ]);
    }
  }
}

export function tokenizeCommandInput(input: string): string[] {
  const tokens: string[] = [];
  let currentToken = '';
  let quoteCharacter: '"' | "'" | null = null;
  let escaping = false;

  const pushCurrentToken = () => {
    if (currentToken.length === 0) {
      return;
    }

    tokens.push(currentToken);
    currentToken = '';
  };

  const characters = input.trim();

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];

    if (escaping) {
      currentToken += character;
      escaping = false;
      continue;
    }

    if (character === '\\') {
      const nextCharacter = characters[index + 1];

      // 仅在转义引号或反斜杠时消费反斜杠；其余情况（例如 Windows 路径 C:\Users）按字面量保留。
      if (nextCharacter === '"' || nextCharacter === "'" || nextCharacter === '\\') {
        escaping = true;
        continue;
      }

      currentToken += character;
      continue;
    }

    if (quoteCharacter) {
      if (character === quoteCharacter) {
        quoteCharacter = null;
        continue;
      }

      currentToken += character;
      continue;
    }

    if (character === '"' || character === "'") {
      quoteCharacter = character;
      continue;
    }

    if (/\s/.test(character)) {
      pushCurrentToken();
      continue;
    }

    currentToken += character;
  }

  pushCurrentToken();
  return tokens;
}

export interface CommandSelectionState {
  providerId: string | null;
  modelId: string | null;
  sessionId: string | null;
}

export function createCommandSelectionState(): CommandSelectionState {
  return {
    providerId: null,
    modelId: null,
    sessionId: null,
  };
}

export function registerCoreCommands(
  dispatcher: CommandDispatcher,
  getWorkspaceRoot: () => string,
  channelService?: ChannelService,
  setCredential?: (target: string, secret: string) => Promise<void>,
): void {
  dispatcher.register('/ping', () => successResult('PING_OK', 'Pueblo foundation is ready'));
  dispatcher.register('/help', () => successResult('HELP', 'Available commands', {
    commands: dispatcher.listCommands(),
  }));
  dispatcher.register('/auto-save', createAutoSaveHandler());
  dispatcher.register('/undo', createUndoHandler(getWorkspaceRoot));

  if (channelService) {
    dispatcher.register('/channel', createChannelCommand({
      channelService,
      setCredential: setCredential ?? (async () => {}),
    }));
  }
}
