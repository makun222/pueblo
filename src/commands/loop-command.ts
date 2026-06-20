import type { CommandHandler } from './dispatcher.js';
import type { CommandResult } from '../shared/result.js';
import { successResult, failureResult, createOutputBlock } from '../shared/result.js';
import { LoopRunner } from '../agent/loop-runner.js';
import type { LoopConfig, LoopResult, RunRoundFn, OnRoundProgress } from '../agent/loop-runner.js';
import type { LoopJobManager as AgentLoopJobManager } from '../agent/loop-job-manager.js';
import { AgentTaskRunner } from '../agent/task-runner.js';
import type { RunAgentTaskInput } from '../agent/task-runner.js';
import { ContextResolver } from '../agent/context-resolver.js';
import { SessionService } from '../sessions/session-service.js';
import { guardVagueGoal, type CallModelFn } from '../utils/guard-vague-goal.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface LoopCommandDependencies {
  taskRunner: AgentTaskRunner;
  contextResolver: ContextResolver;
  sessionService: SessionService;
  cwd: string;
  /** Publish incremental output blocks during loop execution (Desktop: IPC to Renderer, CLI: stdout). */
  publishOutput?: (block: ReturnType<typeof createOutputBlock>) => void;
  /** Lock/unlock the submit button while loop is running (Desktop only). */
  setInputLocked?: (locked: boolean) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLoopCommand(deps: LoopCommandDependencies): CommandHandler {
  const { taskRunner, contextResolver, sessionService, cwd } = deps;

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

    // -- validate goal (P0: LLM-based goal clarity check) --------------------
    try {
      const resolved = await contextResolver.resolve({ cwd, workspace: cwd });
      const modelId = resolved.taskContext.selectedModelId;
      const providerId = resolved.taskContext.providerId;

      if (providerId && modelId) {
        const callModel: CallModelFn = async (_modelId: string, prompt: string) => {
          const validationInput: RunAgentTaskInput = {
            goal: prompt,
            sessionId: null,
            providerId,
            modelId: _modelId,
            inputContextSummary: 'pre-flight goal validation',
          };
          const result = await taskRunner.run(validationInput);
          return result.outputSummary ?? '';
        };

        const validationResult = await guardVagueGoal(goal, modelId, callModel);
        if (!validationResult.ok) {
          return failureResult('VALIDATION_FAILED', validationResult.message, []);
        }
        if (!validationResult.data!.valid) {
          return failureResult('VAGUE_GOAL', validationResult.data!.reason, []);
        }
      }
    } catch (err) {
      return failureResult(
        'GOAL_VALIDATION_ERROR',
        err instanceof Error ? err.message : String(err),
        [],
      );
    }

    // -- snapshot goal (Q3: startup snapshot) --------------------------------
    const snapshotGoal = goal;

    // -- create session (one session for the whole loop) ---------------------
    const session = sessionService.createSession(
      `Loop: ${snapshotGoal.slice(0, 80)}`,
    );

    // -- build the runRound closure (Q1: outer wrapper) ----------------------
    // Build a RunRoundFn that delegates to AgentTaskRunner.
    // Signature: (config, prevResult, signal) => Promise<{output; tokenUsage}>
    // Resolve context once before the loop (not inside each round)
    const resolved = await contextResolver.resolve({ activeSessionId: session.id, cwd, workspace: cwd });

    const runRound: RunRoundFn = async (config, _prevResult, _signal) => {

      const providerId = resolved.taskContext.providerId;
      const modelId = resolved.taskContext.selectedModelId;

      if (!providerId || !modelId) {
        throw new Error('No provider or model selected. Use /model to pick one first.');
      }

      // Build the task input for this round.
      // Round 1: use goal as user input.
      // Subsequent rounds: use previous LLM output as user input, with goal attached.
      const roundGoal = _prevResult
        ? `${_prevResult.output}\n\n[Round ${config.round + 1}] ${config.goal}`
        : `[Round ${config.round + 1}] ${config.goal}`;
      const taskInput: RunAgentTaskInput = {
        goal: roundGoal,
        sessionId: session.id,
        providerId,
        modelId,
        inputContextSummary: config.accumulatedContext,
        taskContext: resolved.taskContext,
        prompts: resolved.taskContext.prompts,
      };

      const task = await taskRunner.run(taskInput);
      const output = task.outputSummary ?? '';

      // Token usage is accumulated by the LoopRunner.
      // We return 0 here because AgentTask does not directly expose per-request metrics.
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

/**
 * Create an async loop command handler for Desktop usage.
 *
 * This variant parses `/loop` arguments into a {@link LoopJobConfig}
 * and returns `LOOP_STARTED` **without** running the loop synchronously.
 * The caller (typically the Desktop IPC layer) is responsible for
 * starting an actual background loop job via {@link AgentLoopJobManager}.
 */
export function createLoopCommandAsync(): CommandHandler {
  return async (args: string[]) => {
    const argStr = args.join(' ');

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

    return successResult(
      'LOOP_STARTED',
      `Loop job queued for: "${goal}"`,
      {
        jobId: 'pending',
        config: { goal, maxRounds, maxTokensPerRound: maxTokens, judge },
      },
    );
  };
}
