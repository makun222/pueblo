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
  }
  | {
    readonly kind: 'deferred';
    readonly reason: 'explicit';
    readonly normalizedInput: string;
  }
  | {
    readonly kind: 'reject';
    readonly reason: 'explicit';
    readonly message: string;
  };

export interface WorkflowRouterDeps {
  readonly hasWorkflowCommand?: () => boolean;
}

export class WorkflowRouter {
  constructor(
    private readonly config: Pick<AppConfig, 'workflow'>,
    private readonly registry: Pick<WorkflowRegistry, 'getDefinition' | 'hasDefinition' | 'listDefinitions'>,
    private readonly deps: WorkflowRouterDeps = {},
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

    if (!this.config.workflow.autoRoute.enabled) {
      return { kind: 'pass-through', reason: 'none' };
    }

    if ((args.estimatedSteps ?? 0) > this.config.workflow.maxDirectTaskSteps) {
      return this.createHandoff(
        args.preferredWorkflowType ?? (this.config.workflow.defaultWorkflowType as WorkflowType),
        trimmed,
        'step-budget',
      );
    }

    const keywords = this.collectRouteKeywords();
    const keywordMatch = keywords.find((keyword) => matchesRouteKeyword(trimmed, keyword));
    if (keywordMatch) {
      return this.createHandoff(
        args.preferredWorkflowType ?? (this.config.workflow.defaultWorkflowType as WorkflowType),
        trimmed,
        'keyword',
      );
    }

    return { kind: 'pass-through', reason: 'none' };
  }

  private resolveExplicitWorkflow(input: string, preferredWorkflowType: WorkflowType | null): WorkflowRouteDecision | null {
    if (!input.startsWith('/workflow')) {
      return null;
    }

    const commandRegistered = this.deps.hasWorkflowCommand?.() ?? true;
    if (!commandRegistered) {
      return { kind: 'deferred', reason: 'explicit', normalizedInput: input };
    }

    const segments = input.split(/\s+/).slice(1);
    const maybeType = segments[0] as WorkflowType | undefined;
    const hasExplicitType = Boolean(maybeType) && this.registry.hasDefinition(maybeType!);
    if (!hasExplicitType && !preferredWorkflowType && !this.registry.hasDefinition(this.config.workflow.defaultWorkflowType as WorkflowType)) {
      return { kind: 'reject', reason: 'explicit', message: `No workflow type is registered for "${maybeType ?? '(default)'}".` };
    }

    const workflowType = hasExplicitType
      ? maybeType!
      : (preferredWorkflowType ?? (this.config.workflow.defaultWorkflowType as WorkflowType));
    const normalizedInput = hasExplicitType ? segments.slice(1).join(' ').trim() : segments.join(' ').trim();

    return this.createHandoff(workflowType, normalizedInput || input, 'explicit');
  }

  private collectRouteKeywords(): string[] {
    const keywords = new Set<string>();
    for (const keyword of this.config.workflow.autoRoute.routeKeywords) {
      keywords.add(keyword);
    }
    for (const keyword of this.config.workflow.routeKeywords) {
      keywords.add(keyword);
    }
    return [...keywords];
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

function matchesRouteKeyword(input: string, keyword: string): boolean {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) {
    return false;
  }

  const lowered = input.toLowerCase();
  if (lowered === normalizedKeyword) {
    return true;
  }

  return lowered.startsWith(`${normalizedKeyword} `) || new RegExp(`\\b${escapeRegExp(normalizedKeyword)}\\b`).test(lowered);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
