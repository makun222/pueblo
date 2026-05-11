import type { AppConfig } from '../shared/config';
import type { WorkflowType } from '../shared/schema';
import type { WorkflowRegistry } from './workflow-registry';

export type WorkflowRouteReason = 'none' | 'explicit' | 'keyword' | 'step-budget';

export type WorkflowRouteDecision =
  | {
    readonly kind: 'pass-through';
    readonly reason: 'none';
  }
  | {
    readonly kind: 'handoff';
    readonly workflowType: WorkflowType;
    readonly reason: Exclude<WorkflowRouteReason, 'none'>;
    readonly normalizedInput: string;
  };

export class WorkflowRouter {
  constructor(
    private readonly config: Pick<AppConfig, 'workflow'>,
    private readonly registry: Pick<WorkflowRegistry, 'getDefinition' | 'hasDefinition' | 'listDefinitions'>,
  ) {}

  decide(args: {
    readonly input: string;
    readonly estimatedSteps?: number | null;
    readonly preferredWorkflowType?: WorkflowType | null;
  }): WorkflowRouteDecision {
    const trimmed = args.input.trim();
    if (!trimmed || !this.config.workflow.enabled) {
      return { kind: 'pass-through', reason: 'none' };
    }

    const explicit = this.resolveExplicitWorkflow(trimmed, args.preferredWorkflowType ?? null);
    if (explicit) {
      return explicit;
    }

    if ((args.estimatedSteps ?? 0) > this.config.workflow.maxDirectTaskSteps) {
      return this.createHandoff(
        args.preferredWorkflowType ?? (this.config.workflow.defaultWorkflowType as WorkflowType),
        trimmed,
        'step-budget',
      );
    }

    const keywordMatch = this.config.workflow.routeKeywords.find((keyword) => trimmed.toLowerCase().includes(keyword.toLowerCase()));
    if (keywordMatch) {
      return this.createHandoff(
        args.preferredWorkflowType ?? (this.config.workflow.defaultWorkflowType as WorkflowType),
        trimmed,
        'keyword',
      );
    }

    const definitionMatch = this.registry
      .listDefinitions()
      .find((definition) => definition.matchesInput?.(trimmed));
    if (definitionMatch) {
      return this.createHandoff(definitionMatch.type, trimmed, 'keyword');
    }

    return { kind: 'pass-through', reason: 'none' };
  }

  private resolveExplicitWorkflow(input: string, preferredWorkflowType: WorkflowType | null): WorkflowRouteDecision | null {
    if (!input.startsWith('/workflow')) {
      return null;
    }

    const segments = input.split(/\s+/).slice(1);
    const maybeType = segments[0] as WorkflowType | undefined;
    const hasExplicitType = Boolean(maybeType) && this.registry.hasDefinition(maybeType!);
    const workflowType = hasExplicitType
      ? maybeType!
      : (preferredWorkflowType ?? (this.config.workflow.defaultWorkflowType as WorkflowType));
    const normalizedInput = hasExplicitType ? segments.slice(1).join(' ').trim() : segments.join(' ').trim();

    return this.createHandoff(workflowType, normalizedInput || input, 'explicit');
  }

  private createHandoff(
    workflowType: WorkflowType,
    normalizedInput: string,
    reason: Exclude<WorkflowRouteReason, 'none'>,
  ): WorkflowRouteDecision {
    if (!this.registry.getDefinition(workflowType)) {
      return { kind: 'pass-through', reason: 'none' };
    }

    return {
      kind: 'handoff',
      workflowType,
      reason,
      normalizedInput,
    };
  }
}
