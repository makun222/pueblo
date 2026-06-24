// ============================================================================
// camel-agent.ts — CamelAgent 核心类
// ============================================================================

import type {
  CamelStatus,
  CamelBudgetStrategy,
  CamelAgentInput,
  CamelTurnContext,
  CamelCallback,
  CamelReport,
  ExecuteTurnInput,
  ExecuteTurnOutput,
  ExecuteTurnFn,
} from './camel-types';
import { CamelContext } from './camel-context';

/** 回合执行结果（内部中间类型） */
interface TurnResult {
  suggestion: string;
  context: CamelTurnContext;
}

/**
 * CamelAgent — 骆驼式多回合 Agent
 *
 * 状态机:
 *   pending ──[start()]──▶ running ──[完成]────▶ completed
 *                                  ──[错误]────▶ failed
 *                                  ──[cancel()]▶ cancelled
 *
 * 回合循环（每回合）:
 *   getContext → checkBudget → executeTurn → processResult → repeat
 *
 * 错误处理（5 种路径）:
 *   1. executeTurn 拒绝 → failed
 *   2. 预算耗尽 → completed（优雅终止）
 *   3. 外部 AbortSignal → cancelled
 *   4. 回调抛出异常 → 静默捕获并继续
 *   5. maxSteps 达到 → completed
 */
export class CamelAgent {
  private status: CamelStatus = 'pending';
  private readonly goal: string;
  private readonly sessionId: string;
  private readonly providerId: string;
  private readonly modelId: string;
  private readonly maxSteps: number;
  private readonly budgetStrategy: CamelBudgetStrategy;
  private readonly budgetLimit: number;
  private readonly signal?: AbortSignal;
  private readonly callbacks: CamelCallback[];
  private readonly executeTurnFn: ExecuteTurnFn;
  private readonly contextManager: CamelContext;
  private result: string | null = null;
  private error: Error | null = null;
  private totalSteps = 0;

  constructor(input: CamelAgentInput, executeTurn: ExecuteTurnFn) {
    this.goal = input.goal;
    this.sessionId = input.sessionId;
    this.providerId = input.providerId;
    this.modelId = input.modelId;
    this.maxSteps = input.maxSteps ?? 50;
    this.budgetStrategy = input.budgetStrategy ?? 'fixed';
    this.budgetLimit = input.budgetLimit ?? 25;
    this.signal = input.signal;
    this.callbacks = input.callbacks ?? [];
    this.executeTurnFn = executeTurn;
    this.contextManager = new CamelContext(this.budgetLimit);
  }

  /** 获取当前状态 */
  getStatus(): CamelStatus {
    return this.status;
  }

  /** 启动执行 */
  async start(): Promise<CamelReport> {
    this.transitionTo('running');

    try {
      while (this.status === 'running') {
        // 错误路径 3: 外部取消信号
        if (this.signal?.aborted) {
          this.transitionTo('cancelled');
          break;
        }

        // 错误路径 5: maxSteps 达到上限
        if (this.totalSteps >= this.maxSteps) {
          this.result = this.goal;
          this.transitionTo('completed');
          break;
        }

        // 错误路径 2: 预算耗尽
        if (!this.hasBudget()) {
          this.result = this.goal;
          this.transitionTo('completed');
          break;
        }

        const turnNumber = this.contextManager.getConsumedSteps() + 1;
        this.emitTurnStart(turnNumber);

        // 错误路径 1: executeTurn 拒绝 → 外层 catch 捕获
        const context = this.contextManager.get();
        const turnResult = await this.runTurn(context);

        // 记录回合结果
        this.contextManager.recordTurn(turnResult.suggestion);
        this.totalSteps++;

        this.emitTurnComplete(turnNumber);

        // 检查 LLM 是否指示完成（空建议 = 完成）
        if (this.isComplete(turnResult.suggestion)) {
          this.result = turnResult.suggestion;
          this.transitionTo('completed');
          break;
        }
      }
    } catch (err) {
      this.error = err instanceof Error ? err : new Error(String(err));
      this.transitionTo('failed');
    }

    return this.buildReport();
  }

  /** 取消执行 */
  cancel(): void {
    if (this.status === 'running') {
      this.transitionTo('cancelled');
    }
  }

  // ======== 内部方法 ========

  /** 状态迁移 */
  private transitionTo(newStatus: CamelStatus): void {
    const oldStatus = this.status;
    this.status = newStatus;

    if (
      newStatus === 'completed' ||
      newStatus === 'failed' ||
      newStatus === 'cancelled'
    ) {
      // Final 状态：回调顺序 → onComplete → onStatusChange → onError
      this.emitComplete();
      this.emitStatusChange(newStatus);
      if (newStatus === 'failed' && this.error) {
        this.emitError(this.error);
      }
    } else {
      // 非 final 状态（如 pending→running）
      this.emitStatusChange(newStatus);
    }

    // 如果从 running 转为 cancelled, 记录 cancel 日志
    if (oldStatus === 'running' && newStatus === 'cancelled') {
      this.result = null;
    }
  }

  /** 预算检查 */
  private hasBudget(): boolean {
    switch (this.budgetStrategy) {
      case 'fixed':
        return this.contextManager.getRemainingBudget() > 0;
      case 'adaptive':
        return this.totalSteps < this.maxSteps;
      case 'unlimited':
        return true;
      default:
        return true;
    }
  }

  /** 执行单回合（可被子类覆写用于测试） */
  protected async runTurn(context: CamelTurnContext): Promise<TurnResult> {
    // 将 goal 注入 contextSummary，供 executeTurn 构建 system prompt
    context.contextSummary['goal'] = this.goal;
    const input: ExecuteTurnInput = {
      context,
      providerId: this.providerId,
      modelId: this.modelId,
      signal: this.signal,
    };
    const output: ExecuteTurnOutput = await this.executeTurnFn(input);
    return {
      suggestion: output.suggestion,
      context: output.context,
    };
  }

  /** 判断建议是否表示完成 */
  private isComplete(suggestion: string): boolean {
    return suggestion === '' || suggestion === '[DONE]';
  }

  /** 构建最终报告 */
  private buildReport(): CamelReport {
    return {
      status: this.status,
      result: this.result,
      totalSteps: this.totalSteps,
      totalTurns: this.contextManager.getConsumedSteps(),
    };
  }

  // ======== 回调调度 ========

  private emitStatusChange(status: CamelStatus): void {
    for (const cb of this.callbacks) {
      try {
        cb.onStatusChange?.(status);
      } catch {
        /* 错误路径 4: 静默捕获 */
      }
    }
  }

  private emitTurnStart(turn: number): void {
    for (const cb of this.callbacks) {
      try {
        cb.onTurnStart?.(turn);
      } catch {
        /* 静默捕获 */
      }
    }
  }

  private emitTurnComplete(turn: number): void {
    const context = this.contextManager.get();
    for (const cb of this.callbacks) {
      try {
        cb.onTurnComplete?.(turn, context);
      } catch {
        /* 静默捕获 */
      }
    }
  }

  private emitError(error: Error): void {
    for (const cb of this.callbacks) {
      try {
        cb.onError?.(error);
      } catch {
        /* 静默捕获 */
      }
    }
  }

  private emitComplete(): void {
    const report = this.buildReport();
    for (const cb of this.callbacks) {
      try {
        cb.onComplete?.(report);
      } catch {
        /* 静默捕获 */
      }
    }
  }
}
