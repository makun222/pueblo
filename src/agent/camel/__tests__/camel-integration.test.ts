import { describe, it, expect, beforeEach } from 'vitest';
import { CamelAgent } from '../camel-agent';
import type { CamelAgentInput } from '../camel-types';
import { AgentTaskRunner } from '../../task-runner';
import { ProviderRegistry } from '../../../providers/provider-registry';
import type {
  ProviderAdapter,
  ProviderStepContext,
  ProviderStepResult,
  ProviderRunResult,
} from '../../../providers/provider-adapter';
import type { ProviderProfile } from '../../../shared/schema';

// ── Mock Provider Adapter: immediately returns `[DONE]` ──

class MockDoneProviderAdapter implements ProviderAdapter {
  readonly provider = 'mock-done';

  async runStep(_context: ProviderStepContext): Promise<ProviderStepResult> {
    return { type: 'final', outputSummary: '[DONE]' };
  }

  async runTask(): Promise<ProviderRunResult> {
    return { outputSummary: '[DONE]' };
  }
}

// ── Integration Tests ──

describe('CamelAgent integration with AgentTaskRunner.executeTurn', () => {
  let registry: ProviderRegistry;
  let runner: AgentTaskRunner;

  beforeEach(() => {
    registry = new ProviderRegistry();

    const profile: ProviderProfile = {
      id: 'mock-done',
      name: 'Mock Done Provider',
      status: 'active',
      authState: 'missing',
      defaultModelId: 'test-model',
      models: [{ id: 'test-model', name: 'Test Model', supportsTools: false }],
      capabilities: { codeExecution: false, toolUse: false, streaming: false },
    };

    registry.register(profile, new MockDoneProviderAdapter());

    // AgentTaskRunner.executeTurn does not use the repository or toolService,
    // so we can safely pass minimal stubs for dependencies not exercised.
    runner = new AgentTaskRunner(
      registry,
      {} as any, // repository — unused by executeTurn
      undefined, // toolService — unused unless tool calls are made
      {},        // options
    );
  });

  it('should complete with status "completed" when the provider returns [DONE]', async () => {
    const input: CamelAgentInput = {
      goal: 'Test goal',
      sessionId: 'test-session',
      providerId: 'mock-done',
      modelId: 'test-model',
      maxSteps: 1,
      budgetLimit: 10,
    };

    const agent = new CamelAgent(input, runner.executeTurn.bind(runner));
    const report = await agent.start();

    expect(report.status).toBe('completed');
  });
});
