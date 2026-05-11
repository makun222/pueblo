import { describe, expect, it } from 'vitest';
import type { CliDependencies } from '../../src/cli/index';
import { renderToolApprovalPrompt, runInteractiveCliSession } from '../../src/cli/index';
import type { ToolApprovalDecision, ToolApprovalRequest } from '../../src/agent/task-runner';
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
      listAgentSessions() {
        return [];
      },
      listSessionMemories() {
        return [];
      },
      selectSession() {
        throw new Error('not implemented for interactive test');
      },
      setProgressReporter() {},
      setToolApprovalHandler() {},
      setToolApprovalBatchHandler() {},
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

  it('renders approval previews with title and detail blocks', () => {
    const prompt = renderToolApprovalPrompt({
      taskId: 'task-1',
      toolCallId: 'call-1',
      toolName: 'edit',
      args: {
        path: 'src/example.ts',
        oldText: 'old',
        newText: 'new',
      },
      title: 'Allow edit in src/example.ts?',
      summary: 'src/example.ts @ lines 3-4\n@@ lines 3-4 @@\n- old\n+ new',
      detail: 'Path: src/example.ts\n\nScope: lines 3-4\n\n@@ lines 3-4 @@\n- old\n+ new',
    });

    expect(prompt).toContain('[TOOL APPROVAL] edit');
    expect(prompt).toContain('Allow edit in src/example.ts?');
    expect(prompt).toContain('src/example.ts @ lines 3-4');
    expect(prompt).toContain('@@ lines 3-4 @@');
    expect(prompt).toContain('- old');
    expect(prompt).toContain('+ new');
    expect(prompt).toContain('Approve? (o=Allow once / a=Allow ALL / n=Deny)');
  });

  it('passes tri-state approval decisions through the interactive handler', async () => {
    const registeredHandlers: ToolApprovalDecision[] = [];
    let approvalHandler: ((request: ToolApprovalRequest) => Promise<ToolApprovalDecision>) | null = null;
    const cli: CliDependencies = {
      dispatcher: {} as never,
      async submitInput() {
        return successResult('HANDLED', 'Handled');
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
      listAgentProfiles() { return []; },
      startAgentSession() { throw new Error('not implemented for interactive test'); },
      listAgentSessions() { return []; },
      listSessionMemories() { return []; },
      selectSession() { throw new Error('not implemented for interactive test'); },
      setProgressReporter() {},
      setToolApprovalHandler(handler) {
        if (handler) {
          approvalHandler = handler;
        }
      },
      setToolApprovalBatchHandler() {},
      databaseClose() {},
    };

    await runInteractiveCliSession(cli, {
      isInteractive: true,
      readLine: async (prompt) => {
        if (prompt === 'approval> ') {
          return registeredHandlers.length === 0 ? 'o' : 'a';
        }

        return '/exit';
      },
      write: () => {},
    });

    const activeApprovalHandler: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision> = approvalHandler ?? (async () => {
      throw new Error('Expected approval handler to be registered');
    });

    registeredHandlers.push(await activeApprovalHandler({
      taskId: 'task-1',
      toolCallId: 'call-1',
      toolName: 'edit',
      args: { path: 'src/example.ts', oldText: 'old', newText: 'new' },
      title: 'Allow edit in src/example.ts?',
      summary: 'src/example.ts',
      detail: 'Path: src/example.ts',
    }));
    registeredHandlers.push(await activeApprovalHandler({
      taskId: 'task-2',
      toolCallId: 'call-2',
      toolName: 'exec',
      args: { command: 'npm test' },
      title: 'Allow command execution?',
      summary: 'npm test',
      detail: 'Command: npm test',
    }));

    expect(registeredHandlers).toEqual(['allow-once', 'allow-all']);
  });
});