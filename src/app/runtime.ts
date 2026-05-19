import type { AppConfig } from '../shared/config';
import type { CommandResult } from '../shared/result';
import type { IpcInputEnvelope, RendererOutputBlock } from '../shared/schema';

export interface RuntimeMessage {
  readonly block: RendererOutputBlock;
}

export interface RuntimeCoordinatorDependencies {
  readonly config: AppConfig;
  readonly submitInput: (input: IpcInputEnvelope, signal?: AbortSignal) => Promise<CommandResult<unknown>>;
}

export class RuntimeCoordinator {
  private readonly listeners = new Set<(message: RuntimeMessage) => void>();
  private disposed = false;

  constructor(
    public readonly config: AppConfig,
    private readonly submitInputHandler: (input: IpcInputEnvelope, signal?: AbortSignal) => Promise<CommandResult<unknown>>,
  ) {}

  onMessage(listener: (message: RuntimeMessage) => void): () => void {
    if (this.disposed) {
      return () => {};
    }

    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(message: RuntimeMessage): void {
    if (this.disposed) {
      return;
    }

    for (const listener of this.listeners) {
      listener(message);
    }
  }

  submitInput(input: IpcInputEnvelope, signal?: AbortSignal): Promise<CommandResult<unknown>> {
    return this.submitInputHandler(input, signal);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

export function createRuntimeCoordinator(dependencies: RuntimeCoordinatorDependencies): RuntimeCoordinator {
  return new RuntimeCoordinator(dependencies.config, dependencies.submitInput);
}
