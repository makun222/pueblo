/**
 * TurnIndexer — 回合索引器
 *
 * 将"回合"概念显式化，封装回合 ID 生成、回合号递增、
 * 以及回合内首步标记的管理。通过 TurnManager 接口向外暴露，
 * 供 Agent 主循环和其他消费者统一使用。
 *
 * 架构决策（对应 architecture-document.md §9.1）：
 * - 回合边界由外部信号驱动（signalTurnEnd），不依赖内部启发式；
 * - turnId 格式为 "<sessionId>-turn-<turnNumber>"，支持全局唯一标识；
 * - isFirstStepInTurn 在回合开始时为 true，第一步消费后由外部重置。
 */

// ---- 公共接口 ----

/**
 * TurnManager — 回合管理器接口
 *
 * 消费者通过此接口读取当前回合状态并在回合结束时发出信号。
 * 所有回合状态变更都通过显式调用完成，不依赖隐式边界检测。
 */
export interface TurnManager {
  /** 当前回合的唯一标识符，格式为 "<sessionId>-turn-<turnNumber>" */
  readonly currentTurnId: string;

  /** 当前回合序号（从 1 开始） */
  readonly turnNumber: number;

  /** 是否处于当前回合的第一步（还未生成任何 tool-call） */
  readonly isFirstStepInTurn: boolean;

  /**
   * 发出回合结束信号
   *
   * 效果：
   *   - turnNumber 递增 1
   *   - isFirstStepInTurn 重置为 true
   *   - currentTurnId 刷新为新 ID
   */
  signalTurnEnd(): void;

  /** 标记当前回合的第一步已被消费 */
  markStepConsumed(): void;
}

// ---- 配置 ----

export interface TurnIndexerOptions {
  /** 起始回合号，默认为 1 */
  startingTurnNumber?: number;
}

// ---- 默认值 ----

const DEFAULT_STARTING_TURN_NUMBER = 1;

// ---- 实现 ----

/**
 * TurnIndexer — TurnManager 的默认实现
 *
 * 职责：
 *  1. 管理回合 ID（由 sessionId + 回合号合成）
 *  2. 管理回合号递增
 *  3. 管理回合内首步标记
 *
 * 该实现是纯内存的、无副作用的。持久化和跨实例同步由
 * 外部调用方（如 SessionService 或 TurnMemoryContext）负责。
 *
 * 使用示例：
 *   const indexer = new TurnIndexer('session-abc', { startingTurnNumber: 3 });
 *   console.log(indexer.currentTurnId); // 'session-abc-turn-3'
 *   indexer.markStepConsumed();
 *   indexer.signalTurnEnd();
 *   console.log(indexer.currentTurnId); // 'session-abc-turn-4'
 */
export class TurnIndexer implements TurnManager {
  private _sessionId: string;
  private _turnNumber: number;
  private _isFirstStepInTurn: boolean;

  constructor(sessionId: string, options?: TurnIndexerOptions) {
    if (!sessionId || sessionId.trim().length === 0) {
      throw new Error('TurnIndexer: sessionId must be a non-empty string');
    }

    const startingTurnNumber =
      options?.startingTurnNumber ?? DEFAULT_STARTING_TURN_NUMBER;

    if (
      !Number.isInteger(startingTurnNumber) ||
      startingTurnNumber < 1
    ) {
      throw new Error(
        'TurnIndexer: startingTurnNumber must be a positive integer',
      );
    }

    this._sessionId = sessionId;
    this._turnNumber = startingTurnNumber;
    this._isFirstStepInTurn = true;
  }

  // ---- TurnManager 实现 ----

  get currentTurnId(): string {
    return `${this._sessionId}-turn-${this._turnNumber}`;
  }

  get turnNumber(): number {
    return this._turnNumber;
  }

  get isFirstStepInTurn(): boolean {
    return this._isFirstStepInTurn;
  }

  signalTurnEnd(): void {
    this._turnNumber += 1;
    this._isFirstStepInTurn = true;
  }

  markStepConsumed(): void {
    this._isFirstStepInTurn = false;
  }
}
