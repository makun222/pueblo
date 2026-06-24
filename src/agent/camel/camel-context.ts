// ============================================================================
// camel-context.ts — CamelAgent 回合间上下文管理
// ============================================================================

import type { CamelTurnContext } from './camel-types';

/** 内部历史记录条目 */
interface HistoryEntry {
  turn: number;
  suggestion: string;
  summary: Record<string, unknown>;
}

/**
 * CamelContext — 回合间上下文管理
 *
 * 职责：
 * - 维护回合历史（HistoryEntry 数组）
 * - 构建上下文摘要（供下一轮 prompt 使用）
 * - 跟踪工作预算（fixed 模式下递减）
 * - 提供 get() 方法生成不可变的 CamelTurnContext 快照
 */
export class CamelContext {
  private history: HistoryEntry[] = [];
  private turnCount = 0;
  private workBudget: number;

  constructor(budgetLimit: number) {
    this.workBudget = budgetLimit;
  }

  /** 获取当前上下文快照 */
  get(): CamelTurnContext {
    return {
      history: this.history.map(
        h => `[turn ${h.turn}] ${h.suggestion}`,
      ),
      contextSummary: this.buildSummary(),
      lastSuggestion:
        this.history.length > 0
          ? this.history[this.history.length - 1].suggestion
          : null,
      turnCount: this.turnCount,
      workBudget: this.workBudget,
    };
  }

  /** 记录一轮建议 */
  recordTurn(suggestion: string): void {
    this.turnCount++;
    this.workBudget = Math.max(0, this.workBudget - 1);
    this.history.push({
      turn: this.turnCount,
      suggestion,
      summary: {},
    });
  }

  /** 消耗指定步数的预算 */
  consumeBudget(amount: number): void {
    this.workBudget = Math.max(0, this.workBudget - amount);
  }

  /** 获取剩余预算 */
  getRemainingBudget(): number {
    return this.workBudget;
  }

  /** 已执行的回合数（即已消耗的预算步数） */
  getConsumedSteps(): number {
    return this.history.length;
  }

  /** 构建上下文摘要 */
  private buildSummary(): Record<string, unknown> {
    return {
      totalTurns: this.turnCount,
      consumedSteps: this.history.length,
      remainingBudget: this.workBudget,
    };
  }
}
