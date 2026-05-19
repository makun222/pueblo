import { successResult, type CommandResult } from '../shared/result';
import type { CommandDispatcher } from './dispatcher';
import type { RuntimeCoordinator } from '../app/runtime';
import type { InputAttachmentManifest, IpcInputEnvelope } from '../shared/schema';

export interface InputRouterDependencies {
  readonly dispatcher: CommandDispatcher;
  readonly runTaskFromText: (text: string, attachments?: InputAttachmentManifest[]) => Promise<CommandResult<unknown>>;
  readonly routeTextInput?: (text: string, attachments?: InputAttachmentManifest[]) => Promise<CommandResult<unknown> | null>;
}

export class InputRouter {
  constructor(private readonly dependencies: InputRouterDependencies) {}

  async route(input: string | IpcInputEnvelope): Promise<CommandResult<unknown>> {
    const envelope = normalizeInputEnvelope(input);
    const trimmed = envelope.inputText.trim();

    if (!trimmed) {
      return successResult('INPUT_IGNORED', 'Empty input ignored');
    }

    if (trimmed.startsWith('/')) {
      return this.dependencies.dispatcher.dispatch({ input: trimmed });
    }

    const routedResult = envelope.attachments.length > 0
      ? await this.dependencies.routeTextInput?.(trimmed, envelope.attachments)
      : await this.dependencies.routeTextInput?.(trimmed);
    if (routedResult) {
      return routedResult;
    }

    return envelope.attachments.length > 0
      ? this.dependencies.runTaskFromText(trimmed, envelope.attachments)
      : this.dependencies.runTaskFromText(trimmed);
  }
}

export async function routeInput(args: { input: string | IpcInputEnvelope; runtime: RuntimeCoordinator; signal?: AbortSignal }): Promise<CommandResult<unknown>> {
  return args.runtime.submitInput(normalizeInputEnvelope(args.input), args.signal);
}

function normalizeInputEnvelope(input: string | IpcInputEnvelope): IpcInputEnvelope {
  if (typeof input !== 'string') {
    return {
      ...input,
      attachments: input.attachments ?? [],
    };
  }

  return {
    requestId: `${new Date().toISOString()}-${Math.random().toString(16).slice(2)}`,
    windowId: 'cli',
    sessionId: null,
    inputText: input,
    attachments: [],
    submittedAt: new Date().toISOString(),
  };
}
