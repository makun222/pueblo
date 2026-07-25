/**
 * SubAgent type definitions
 */

export type SubAgentStatus = 'running' | 'completed' | 'failed';

export interface SubAgentTask {
  readonly taskId: string;
  status: SubAgentStatus;
  result?: string;
  error?: string;
  readonly createdAt: number;
  completedAt?: number;
}

export interface SpawnSubAgentArgs {
  /** Goal/purpose for the subagent */
  goal: string;
  /** Maximum steps the subagent can take (default: 50) */
  maxSteps?: number;
  /** Budget limit (relevance cost, default: 25) */
  budgetLimit?: number;
}

export interface CheckSubAgentArgs {
  /** Task ID returned by spawn_subagent */
  taskId: string;
}

export interface SubAgentToolDeps {
  /** Current session ID */
  sessionId: string;
  /** Provider ID (e.g. 'anthropic') */
  providerId: string;
  /** Model ID (e.g. 'claude-3-haiku-20240307') */
  modelId: string;
  /** ExecuteTurnFn to pass to spawned CamelAgents */
  executeTurnFn: any;
  /** Callback for parent-level status updates (optional) */
  onStatusUpdate?: (taskId: string, status: SubAgentStatus, extra?: { result?: string; error?: string }) => void;
}
