import type { WorkflowType } from '../shared/schema';

export interface WorkflowDefinition {
  readonly type: WorkflowType;
  readonly description: string;
  readonly matchesInput?: (input: string) => boolean;
}

export class WorkflowRegistry {
  private readonly definitions = new Map<WorkflowType, WorkflowDefinition>();

  constructor(definitions: WorkflowDefinition[] = []) {
    definitions.forEach((definition) => {
      this.register(definition);
    });
  }

  register(definition: WorkflowDefinition): void {
    this.definitions.set(definition.type, definition);
  }

  getDefinition(type: WorkflowType): WorkflowDefinition | null {
    return this.definitions.get(type) ?? null;
  }

  hasDefinition(type: WorkflowType): boolean {
    return this.definitions.has(type);
  }

  listDefinitions(): WorkflowDefinition[] {
    return [...this.definitions.values()];
  }
}
