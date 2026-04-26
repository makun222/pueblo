import { describe, expect, it } from 'vitest';
import type { CliDependencies } from '../../src/cli/index';
import { runInteractiveCliSession } from '../../src/cli/index';
import { successResult } from '../../src/shared/result';

describe('interactive cli session', () => {
  it('keeps the terminal session open and routes input until exit', async () => {
    const writes: string[] = [];
    const inputs = ['/ping', 'inspect workflow', '/exit'];
    const handledInputs: string[] = [];
    let index = 0;
    const cli: CliDependencies = {
      dispatcher: {} as never,
      async submitInput(input: string) {
        handledInputs.push(input);
        return successResult('HANDLED', `Handled ${input}`);
      },
      getRuntimeStatus() {
        return {
          providerId: null,
          providerName: null,
          agentProfileId: null,
          agentProfileName: null,
          agentInstanceId: null,
          modelId: null,
          modelName: null,
          activeSessionId: null,
          contextCount: {
            estimatedTokens: 0,
            contextWindowLimit: null,
            utilizationRatio: null,
            messageCount: 0,
            selectedPromptCount: 0,
            selectedMemoryCount: 0,
            derivedMemoryCount: 0,
          },
          modelMessageCount: 0,
          modelMessageCharCount: 0,
          selectedPromptCount: 0,
          selectedMemoryCount: 0,
          backgroundSummaryStatus: {
            state: 'idle',
            activeSummarySessionId: null,
            lastSummaryAt: null,
            lastSummaryMemoryId: null,
          },
        };
      },
      listAgentProfiles() {
        return [];
      },
      startAgentSession() {
        throw new Error('not implemented for interactive test');
      },
      databaseClose() {},
    };

    await runInteractiveCliSession(cli, {
      isInteractive: true,
      readLine: async () => inputs[index++] ?? '/exit',
      write: (text) => {
        writes.push(text);
      },
    });

    expect(handledInputs).toEqual(['/ping', 'inspect workflow']);
    expect(writes.join('')).toContain('Pueblo CLI foundation ready');
    expect(writes.join('')).toContain('Enter /help for commands, type a slash command or plain-text task, or use /exit to quit.');
    expect(writes.join('')).toContain('[HANDLED] Handled /ping');
    expect(writes.join('')).toContain('[HANDLED] Handled inspect workflow');
    expect(writes.join('')).toContain('Exiting Pueblo CLI.');
  });
});