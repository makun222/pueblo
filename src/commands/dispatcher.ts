import { failureResult, successResult, type CommandResult } from '../shared/result';

export interface DispatchRequest {
  readonly input: string;
}

export type CommandHandler = (args: string[]) => CommandResult<unknown> | Promise<CommandResult<unknown>>;

export class CommandDispatcher {
  private readonly handlers = new Map<string, CommandHandler>();

  register(commandName: string, handler: CommandHandler): void {
    this.handlers.set(commandName, handler);
  }

  listCommands(): string[] {
    return [...this.handlers.keys()].sort((left, right) => left.localeCompare(right));
  }

  async dispatch(request: DispatchRequest): Promise<CommandResult> {
    const trimmed = request.input.trim();

    if (!trimmed.startsWith('/')) {
      return failureResult('INVALID_COMMAND', 'Commands must start with /', ['Use a supported slash command.']);
    }

    const [commandName, ...args] = trimmed.split(/\s+/);
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

export function registerCoreCommands(dispatcher: CommandDispatcher): void {
  dispatcher.register('/ping', () => successResult('PING_OK', 'Pueblo foundation is ready'));
  dispatcher.register('/help', () => successResult('HELP', 'Available commands', {
    commands: dispatcher.listCommands(),
  }));
}
