import type { WorkflowContinuationAction } from '../shared/schema';
import type { WorkflowInstance } from '../shared/schema';

export type ContinuationDecision = 'continue' | 'interrupt-and-run' | 'abandon';

export interface ContinuationPolicyInput {
  readonly workflow: WorkflowInstance;
  readonly input: string;
  readonly defaultAction: WorkflowContinuationAction;
}

export interface ContinuationPolicyResult {
  readonly decision: ContinuationDecision;
  readonly normalizedInput: string;
  readonly reason: string;
}

const ABANDON_PHRASES = ['stop workflow', 'cancel workflow', 'abort workflow'];
const PAUSE_COMMAND = '/workflow-pause';
const CANCEL_COMMAND = '/workflow-cancel';

export function resolveContinuation(input: ContinuationPolicyInput): ContinuationPolicyResult {
  const trimmed = input.input.trim();
  const lowered = trimmed.toLowerCase();

  if (trimmed === '' ) {
    return { decision: 'continue', normalizedInput: trimmed, reason: 'Empty input defaults to continuation.' };
  }

  if (trimmed.startsWith(CANCEL_COMMAND) || ABANDON_PHRASES.some((phrase) => lowered === phrase || lowered.startsWith(`${phrase} `))) {
    return { decision: 'abandon', normalizedInput: trimmed, reason: 'Explicit cancel/abandon request.' };
  }

  if (trimmed.startsWith(PAUSE_COMMAND) || trimmed.startsWith('!')) {
    const payload = trimmed.startsWith('!')
      ? trimmed.slice(1).trim()
      : trimmed.slice(PAUSE_COMMAND.length).trim();
    return {
      decision: 'interrupt-and-run',
      normalizedInput: payload,
      reason: 'User interrupted the workflow to run an unrelated task.',
    };
  }

  switch (input.defaultAction) {
    case 'pause':
      return {
        decision: 'interrupt-and-run',
        normalizedInput: trimmed,
        reason: 'Default continuation policy is pause; input runs as an independent task.',
      };
    case 'continue':
      return {
        decision: 'continue',
        normalizedInput: trimmed,
        reason: 'Default continuation policy is continue.',
      };
    case 'ask':
    default:
      return {
        decision: 'continue',
        normalizedInput: trimmed,
        reason: 'Default continuation policy is ask; routing continues until the user opts out.',
      };
  }
}

export function buildContinuationPrompt(workflow: WorkflowInstance): string {
  return [
    `An active workflow is running (status: ${workflow.status}).`,
    workflow.activeRoundNumber !== null ? `Active round: ${workflow.activeRoundNumber}` : null,
    `Goal: ${workflow.goal}`,
    '',
    'Reply /workflow-continue to continue, /workflow-pause <task> to run an unrelated task, or /workflow-cancel to abandon.',
  ].filter((line): line is string => Boolean(line)).join('\n');
}
