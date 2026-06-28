import type { CamelContextInput, CamelTurnContext, CamelTurnRecord } from './camel-types';

/**
 * Maintains the Camel turn context with a 3-turn sliding window.
 *
 * - Recent turns are kept in `turns` (max 3).
 * - Old turns are evicted to `taskLog`.
 * - Each `CamelTurnRecord` contains `messages` (full ProviderMessage[] for that turn)
 *   and `suggestion` (the final text summary).
 */
export class CamelContext {
  private sessionId: string;
  private goal: string;
  private budget: number;
  private consumed: number;
  private turns: CamelTurnRecord[] = [];
  private taskLog: string = '';
  private roleDirectives?: string[];
  private targetDirectory?: string;
  private puebloPath?: string;
  private skillPath?: string;
  private additionalPrompts?: string[];

  constructor(input: CamelContextInput) {
    this.sessionId = input.sessionId;
    this.goal = input.goal;
    this.budget = input.budget ?? 50;
    this.consumed = 0;
    this.roleDirectives = input.roleDirectives;
    this.targetDirectory = input.targetDirectory;
    this.puebloPath = input.puebloPath;
    this.skillPath = input.skillPath;
    this.additionalPrompts = input.additionalPrompts;
  }

  /** Return the current context for the next turn. */
  get(): CamelTurnContext {
    return {
      turns: this.turns.slice(),
      taskLog: this.taskLog,
      contextSummary: {
        goal: this.goal,
        roleDirectives: this.roleDirectives,
        targetDirectory: this.targetDirectory,
        puebloPath: this.puebloPath,
        skillPath: this.skillPath,
        additionalPrompts: this.additionalPrompts,
      },
      lastSuggestion:
        this.turns.length > 0
          ? (this.turns[this.turns.length - 1]?.suggestion ?? '')
          : null,
      turnCount: this.turns.length,
      workBudget: this.getRemainingBudget(),
    };
  }

  /** Record a completed turn. Implements 3-turn sliding window. */
  recordTurn(turn: CamelTurnRecord): void {
    // Evict oldest turn to taskLog if we have 3 turns already
    if (this.turns.length >= 3) {
      const evicted = this.turns[0];
      this.taskLog +=
        `\n--- Turn ---\n` +
        `${evicted.suggestion}\n`;
      this.turns = this.turns.slice(1);
    }

    this.turns.push(turn);
  }

  /** Consume one budget step. Returns true if budget remains. */
  consumeBudget(): boolean {
    this.consumed += 1;
    return this.consumed < this.budget;
  }

  /** Get remaining budget steps. */
  getRemainingBudget(): number {
    return Math.max(0, this.budget - this.consumed);
  }

  /** Get consumed step count. */
  getConsumedSteps(): number {
    return this.consumed;
  }
}
