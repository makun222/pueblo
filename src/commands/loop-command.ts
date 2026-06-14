import type { CommandHandler } from './dispatcher.js';
import type { CommandResult } from '../shared/result.js';
import { successResult, failureResult } from '../shared/result.js';
import { LoopRunner } from '../agent/loop-runner.js';
import type { LoopConfig, RunRoundFn } from '../agent/loop-runner.js';
import { AgentTaskRunner } from '../agent/task-runner.js';
import type { RunAgentTaskInput } from '../agent/task-runner.js';
import { ContextResolver } from '../agent/context-resolver.js';
import { SessionService } from '../sessions/session-service.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface LoopCommandDependencies {
  taskRunner: AgentTaskRunner;
  contextResolver: ContextResolver;
  sessionService: SessionService;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLoopCommand(deps: LoopCommandDependencies): CommandHandler {
  const { taskRunner, contextResolver, sessionService } = deps;

  return async (args: string[]): Promise<CommandResult<unknown>> => {
    // -- parse arguments -----------------------------------------------------
    const argStr = args.join(' ').trim();

    const goalMatch = argStr.match(/--goal=(?:"([^"]*)"|(\S+))/);
    const maxRoundsMatch = argStr.match(/--max-rounds=(\d+)/);
    const maxTokensMatch = argStr.match(/--max-tokens=(\d+)/);
    const judgeMatch = argStr.match(/--judge=(flag|llm)/);

    if (!goalMatch) {
      return failureResult(
        'INVALID_ARGUMENT',
        'Missing required --goal parameter.',
        ['Usage: /loop --goal="<target goal>" [--max-rounds=N] [--max-tokens=M] [--judge=flag|llm]'],
      );
    }

    const goal: string = goalMatch[1] || goalMatch[2] || '';
    const maxRounds: number = maxRoundsMatch ? parseInt(maxRoundsMatch[1], 10) : 20;
    const maxTokens: number | undefined = maxTokensMatch ? parseInt(maxTokensMatch[1], 10) : undefined;
    const judge: 'flag' | 'llm' = (judgeMatch?.[1] as 'flag' | 'llm') || 'flag';

    if (!goal) {
      return failureResult('INVALID_ARGUMENT', 'Goal cannot be empty.', []);
    }

    // -- snapshot goal (Q3: startup snapshot) --------------------------------
    const snapshotGoal = goal;

    // -- create session (one session for the whole loop) ---------------------
    const session = sessionService.createSession(
      `Loop: ${snapshotGoal.slice(0, 80)}`,
    );

    // -- build the runRound closure (Q1: outer wrapper) ----------------------
    // Build a RunRoundFn that delegates to AgentTaskRunner.
    // Signature: (round, totalRounds, goal, accumulatedContext) => Promise<{output; tokenUsage}>
    const runRound: RunRoundFn = async (_round, _totalRounds, goal, accumulatedContext) => {
      // Resolve context to get provider/model selection
      const resolved = await contextResolver.resolve({ activeSessionId: session.id });

      const providerId = resolved.taskContext.providerId;
      const modelId = resolved.taskContext.selectedModelId;

      if (!providerId || !modelId) {
        throw new Error('No provider or model selected. Use /model to pick one first.');
      }

      // Build the task input for this round.
      // Prepend round number so the LLM sees its progress within the loop.
      const taskInput: RunAgentTaskInput = {
        goal: `[Round ${_round + 1}] ${goal}`,
        sessionId: session.id,
        providerId,
        modelId,
        inputContextSummary: accumulatedContext,
        taskContext: resolved.taskContext,
        prompts: resolved.taskContext.prompts,
      };

      const task = await taskRunner.run(taskInput);
      const output = task.outputSummary ?? '';

      // Token usage is accumulated by the LoopRunner.
      // We return 0 here because AgentTask does not directly expose per-request
      // token metrics; a future enhancement can wire reportRequestMetrics.
      return { output, tokenUsage: 0 };
    };

    // -- execute the loop (Q1: outer wrapper on TaskRunner) ------------------
    const runner = new LoopRunner();

    try {
      const loopConfig: LoopConfig = { goal: snapshotGoal, maxRounds, maxTokens, judge };
      const loopResult = await runner.run(loopConfig, runRound);

      return successResult(
        'LOOP_COMPLETE',
        `Loop finished: ${loopResult.state} after ${loopResult.rounds.length} round(s).`,
        loopResult,
      );
    } catch (err) {
      return failureResult(
        'LOOP_ERROR',
        err instanceof Error ? err.message : String(err),
        [],
      );
    }
  };
}
