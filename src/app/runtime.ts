import type { AppConfig } from '../shared/config';
import type { CommandResult } from '../shared/result';
import type { RendererOutputBlock } from '../shared/schema';

export interface RuntimeMessage {
  readonly block: RendererOutputBlock;
}

export interface RuntimeCoordinatorDependencies {
  readonly config: AppConfig;
  readonly submitInput: (input: string) => Promise<CommandResult<unknown>>;
}

export class RuntimeCoordinator {
  private readonly listeners = new Set<(message: RuntimeMessage) => void>();

  constructor(
    public readonly config: AppConfig,
    private readonly submitInputHandler: (input: string) => Promise<CommandResult<unknown>>,
  ) {}

  onMessage(listener: (message: RuntimeMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(message: RuntimeMessage): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  submitInput(input: string): Promise<CommandResult<unknown>> {
    return this.submitInputHandler(input);
  }
}

export function createRuntimeCoordinator(dependencies: RuntimeCoordinatorDependencies): RuntimeCoordinator {
  return new RuntimeCoordinator(dependencies.config, dependencies.submitInput);
}
