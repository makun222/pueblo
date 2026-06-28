// ============================================================================
// camel-types.ts — CamelAgent 核心类型定义
// ============================================================================

import type { ProviderMessage } from '../../providers/provider-adapter.js';

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

  // ─── 提示词构建增强字段 ───

  /** 角色行为指令列表（来自 agent 模板，如 "code-master"） */
  roleDirectives?: string[];
  /** 目标仓库根目录路径 */
  targetDirectory?: string;
  /** Pueblo 框架根路径 */
  puebloPath?: string;
  /** Skill 工作空间路径 */
  skillPath?: string;
  /** 调用者传入的附加 prompt 列表 */
  additionalPrompts?: string[];
}

/** 单轮对话的完整记录（消息级上下文，用于滑动窗口） */
export interface CamelTurnRecord {
    /** 轮次序号（从 1 开始） */
    /** Turn 序号，由 CamelContext.recordTurn() 自动分配 */
  turnNumber?: number;
    /** 本轮完整 messages（system / user / assistant / tool results） */
    readonly messages: ProviderMessage[];
    /** 本轮 LLM 最终输出的摘要文本 */
    readonly suggestion: string;
}

/** 回合间上下文 */
export interface CamelContextInput {
  sessionId: string;
  goal: string;
  budget?: number;
  roleDirectives?: string[];
  targetDirectory?: string;
  puebloPath?: string;
  skillPath?: string;
  additionalPrompts?: string[];
}

export interface CamelTurnContext {
  /** 最近 N 轮的完整记录（滑动窗口，由 CamelContextManager 维护） */
  turns: CamelTurnRecord[];
  /** 超出滑动窗口的旧轮日志（追加文本） */
  taskLog: string;
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
  error?: Error;
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
  /** 本轮完整对话记录（消息级，供滑动窗口消费） */
  turn: { messages: ProviderMessage[]; suggestion: string };
}

/** executeTurn 函数签名（由 Stream B 的 task-runner 实现） */
export type ExecuteTurnFn = (
  input: ExecuteTurnInput,
) => Promise<ExecuteTurnOutput>;
