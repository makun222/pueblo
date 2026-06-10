import { describe, it, expect } from 'vitest';
import { TurnIndexer } from '../../src/agent/turn-indexer';

// ============================================================
// TurnIndexer 单元测试
// ============================================================

describe('TurnIndexer', () => {
  // ----------------------------------------------------------
  // 构造与初始化
  // ----------------------------------------------------------
  describe('construction', () => {
    it('should initialize with default turn number 1', () => {
      const indexer = new TurnIndexer('session-abc');

      expect(indexer.turnNumber).toBe(1);
      expect(indexer.currentTurnId).toBe('session-abc-turn-1');
      expect(indexer.isFirstStepInTurn).toBe(true);
    });

    it('should accept a custom starting turn number', () => {
      const indexer = new TurnIndexer('session-xyz', {
        startingTurnNumber: 5,
      });

      expect(indexer.turnNumber).toBe(5);
      expect(indexer.currentTurnId).toBe('session-xyz-turn-5');
      expect(indexer.isFirstStepInTurn).toBe(true);
    });

    it('should throw for empty sessionId', () => {
      expect(() => new TurnIndexer('')).toThrow(
        'TurnIndexer: sessionId must be a non-empty string',
      );
    });

    it('should throw for whitespace-only sessionId', () => {
      expect(() => new TurnIndexer('   ')).toThrow(
        'TurnIndexer: sessionId must be a non-empty string',
      );
    });

    it('should throw for non-positive starting turn number', () => {
      expect(
        () =>
          new TurnIndexer('session', { startingTurnNumber: 0 }),
      ).toThrow('TurnIndexer: startingTurnNumber must be a positive integer');
    });

    it('should throw for non-integer starting turn number', () => {
      expect(
        () =>
          new TurnIndexer('session', { startingTurnNumber: 2.5 }),
      ).toThrow('TurnIndexer: startingTurnNumber must be a positive integer');
    });
  });

  // ----------------------------------------------------------
  // currentTurnId 格式
  // ----------------------------------------------------------
  describe('currentTurnId', () => {
    it('should follow the format "<sessionId>-turn-<number>"', () => {
      const indexer = new TurnIndexer('foo');
      expect(indexer.currentTurnId).toBe('foo-turn-1');

      indexer.signalTurnEnd();
      expect(indexer.currentTurnId).toBe('foo-turn-2');
    });

    it('should handle sessionId containing special characters', () => {
      const indexer = new TurnIndexer('user_123@example.com');
      expect(indexer.currentTurnId).toBe(
        'user_123@example.com-turn-1',
      );
    });
  });

  // ----------------------------------------------------------
  // signalTurnEnd — 回合边界
  // ----------------------------------------------------------
  describe('signalTurnEnd', () => {
    it('should increment turnNumber', () => {
      const indexer = new TurnIndexer('sess');
      expect(indexer.turnNumber).toBe(1);

      indexer.signalTurnEnd();
      expect(indexer.turnNumber).toBe(2);

      indexer.signalTurnEnd();
      expect(indexer.turnNumber).toBe(3);
    });

    it('should reset isFirstStepInTurn to true', () => {
      const indexer = new TurnIndexer('sess');
      indexer.markStepConsumed();
      expect(indexer.isFirstStepInTurn).toBe(false);

      indexer.signalTurnEnd();
      expect(indexer.isFirstStepInTurn).toBe(true);
    });

    it('should update currentTurnId to reflect new turn number', () => {
      const indexer = new TurnIndexer('sess');
      indexer.signalTurnEnd();
      expect(indexer.currentTurnId).toBe('sess-turn-2');
    });
  });

  // ----------------------------------------------------------
  // markStepConsumed — 回合内首步标记
  // ----------------------------------------------------------
  describe('markStepConsumed', () => {
    it('should set isFirstStepInTurn to false', () => {
      const indexer = new TurnIndexer('sess');
      expect(indexer.isFirstStepInTurn).toBe(true);

      indexer.markStepConsumed();
      expect(indexer.isFirstStepInTurn).toBe(false);
    });

    it('should keep isFirstStepInTurn false after multiple calls', () => {
      const indexer = new TurnIndexer('sess');
      indexer.markStepConsumed();
      indexer.markStepConsumed();
      expect(indexer.isFirstStepInTurn).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // 完整回合场景（集成：多回合 + 多步）
  // ----------------------------------------------------------
  describe('multi-turn scenario', () => {
    it('should simulate a realistic multi-turn dialog', () => {
      const indexer = new TurnIndexer('dialog-1');

      // --- 回合 1 ---
      expect(indexer.currentTurnId).toBe('dialog-1-turn-1');
      expect(indexer.isFirstStepInTurn).toBe(true);

      indexer.markStepConsumed();
      expect(indexer.isFirstStepInTurn).toBe(false);

      indexer.signalTurnEnd();

      // --- 回合 2 ---
      expect(indexer.currentTurnId).toBe('dialog-1-turn-2');
      expect(indexer.turnNumber).toBe(2);
      expect(indexer.isFirstStepInTurn).toBe(true);

      indexer.markStepConsumed();
      indexer.signalTurnEnd();

      // --- 回合 3 ---
      expect(indexer.currentTurnId).toBe('dialog-1-turn-3');
      expect(indexer.turnNumber).toBe(3);
      expect(indexer.isFirstStepInTurn).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 边界条件：大数、快速连续 signalTurnEnd
  // ----------------------------------------------------------
  describe('edge cases', () => {
    it('should handle a large starting turn number', () => {
      const indexer = new TurnIndexer('sess', {
        startingTurnNumber: 1000000,
      });

      expect(indexer.turnNumber).toBe(1000000);
      expect(indexer.currentTurnId).toBe('sess-turn-1000000');
    });

    it('should handle rapid successive signalTurnEnd calls', () => {
      const indexer = new TurnIndexer('sess');
      for (let i = 0; i < 100; i++) {
        indexer.signalTurnEnd();
      }
      expect(indexer.turnNumber).toBe(101);
      expect(indexer.currentTurnId).toBe('sess-turn-101');
      expect(indexer.isFirstStepInTurn).toBe(true);
    });

    it('should handle signalTurnEnd immediately after construction without markStepConsumed', () => {
      // Edge case: empty turn (no steps consumed) followed by turn end
      const indexer = new TurnIndexer('empty-turn');
      expect(indexer.isFirstStepInTurn).toBe(true);
      indexer.signalTurnEnd();
      expect(indexer.turnNumber).toBe(2);
      expect(indexer.isFirstStepInTurn).toBe(true);
      expect(indexer.currentTurnId).toBe('empty-turn-turn-2');
    });

    it('should handle re-entrant signalTurnEnd calls (no-op in between)', () => {
      const indexer = new TurnIndexer('reentrant');
      indexer.signalTurnEnd();
      indexer.signalTurnEnd();
      indexer.signalTurnEnd();
      expect(indexer.turnNumber).toBe(4);
      expect(indexer.currentTurnId).toBe('reentrant-turn-4');
    });

    it('should keep isFirstStepInTurn as true after consecutive signalTurnEnd calls', () => {
      const indexer = new TurnIndexer('sess');
      for (let i = 0; i < 5; i++) {
        expect(indexer.isFirstStepInTurn).toBe(true);
        indexer.signalTurnEnd();
      }
      expect(indexer.turnNumber).toBe(6);
    });

    it('should throw when turnNumber overflows MAX_SAFE_INTEGER', () => {
      const indexer = new TurnIndexer('sess', { startingTurnNumber: Number.MAX_SAFE_INTEGER });
      expect(() => indexer.signalTurnEnd()).toThrow('has reached MAX_SAFE_INTEGER');
    });
  });
});
