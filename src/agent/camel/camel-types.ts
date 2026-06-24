// ============================================================================
// camel-types.ts — CamelAgent 核心类型定义
// ============================================================================

/** Agent 生命周期状态 */
export type CamelStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** 预算策略 */
export type CamelBudgetStrategy = 'fixed' | 'adaptive' | 'unlimited';

/** Agent 构造函数入参 */
export interface CamelAgentInput {
  /** 任务目标描述 */
  goal: string;
  /** 会话唯一标识 */
  sessionId: string;
  /** LLM 供应商 ID */
  providerId: string;
  /** 模型 ID */
  modelId: string;
  /** 最大步数（默认 50） */
  maxSteps?: number;
  /** 预算策略（默认 fixed） */
  budgetStrategy?: CamelBudgetStrategy;
  /** 预算上限（默认 25） */
  budgetLimit?: number;
  /** 外部取消信号 */
  signal?: AbortSignal;
  /** 生命周期回调 */
  callbacks?: CamelCallback[];
}

/** 回合间上下文 */
export interface CamelTurnContext {
  /** 历史记录快照 */
  history: string[];
  /** 上下文摘要 */
  contextSummary: Record<string, unknown>;
  /** 上一轮建议 */
  lastSuggestion: string | null;
  /** 回合序号 */
  turnCount: number;
  /** 本轮工作预算（剩余步数） */
  workBudget: number;
}

/** 生命周期回调 */
export interface CamelCallback {
  onStatusChange?: (status: CamelStatus) => void;
  onTurnStart?: (turn: number) => void;
  onTurnComplete?: (turn: number, context: CamelTurnContext) => void;
  onError?: (error: Error) => void;
  onComplete?: (report: CamelReport) => void;
}

/** Agent 执行报告 */
export interface CamelReport {
  status: CamelStatus;
  result: string | null;
  totalSteps: number;
  totalTurns: number;
}

/** executeTurn 入参（由 Stream B 的 task-runner 实现） */
export interface ExecuteTurnInput {
  context: CamelTurnContext;
  providerId: string;
  modelId: string;
  signal?: AbortSignal;
}

/** executeTurn 出参 */
export interface ExecuteTurnOutput {
  suggestion: string;
  context: CamelTurnContext;
}

/** executeTurn 函数签名（由 Stream B 的 task-runner 实现） */
export type ExecuteTurnFn = (
  input: ExecuteTurnInput,
) => Promise<ExecuteTurnOutput>;
