import { successResult, type CommandResult } from '../shared/result';
import type { CommandDispatcher } from './dispatcher';
import type { RuntimeCoordinator } from '../app/runtime';

export interface InputRouterDependencies {
  readonly dispatcher: CommandDispatcher;
  readonly runTaskFromText: (text: string) => Promise<CommandResult<unknown>>;
}

export class InputRouter {
  constructor(private readonly dependencies: InputRouterDependencies) {}

  async route(input: string): Promise<CommandResult<unknown>> {
    const trimmed = input.trim();

    if (!trimmed) {
      return successResult('INPUT_IGNORED', 'Empty input ignored');
    }

    if (trimmed.startsWith('/')) {
      return this.dependencies.dispatcher.dispatch({ input: trimmed });
    }

    return this.dependencies.runTaskFromText(trimmed);
  }
}

export async function routeInput(args: { input: string; runtime: RuntimeCoordinator }): Promise<CommandResult<unknown>> {
  return args.runtime.submitInput(args.input);
}
