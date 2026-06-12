import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopTalkService } from '../../src/desktop/main/talk-service';
import { successResult } from '../../src/shared/result';
import type { DesktopRuntimeStatus } from '../../src/desktop/shared/ipc-contract';
import type { RendererOutputBlock } from '../../src/shared/schema';

const cleanupTasks: Array<() => Promise<void> | void> = [];

function createRuntimeStatus(agentProfileName: string): DesktopRuntimeStatus {
  return {
    providerId: 'github-copilot',
    providerName: 'GitHub Copilot',
    agentProfileId: agentProfileName.toLowerCase(),
    agentProfileName,
    agentInstanceId: `${agentProfileName}-instance`,
    modelId: 'copilot-chat',
    modelName: 'GPT-5.4',
    desktopProcessId: null,
    workspace: 'D:/workspace/trends/pueblo',
    activeSessionId: `${agentProfileName}-session`,
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
    providerUsageStats: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      cachedPromptTokens: 0,
      reasoningTokens: 0,
      promptTokensSent: 0,
      cacheHitRatio: null,
    },
    selectedPromptCount: 0,
    selectedMemoryCount: 0,
    availableProviders: [],
    backgroundSummaryStatus: {
      state: 'idle',
      activeSummarySessionId: null,
      lastSummaryAt: null,
      lastSummaryMemoryId: null,
    },
    workflow: {
      hasActiveWorkflow: false,
      workflowId: null,
      workflowType: null,
      status: null,
      activeRoundNumber: null,
    },
    providerStatuses: {
      githubCopilot: {
        providerId: 'github-copilot',
        authState: 'configured',
        credentialSource: 'env',
        defaultModelId: 'copilot-chat',
        credentialTarget: null,
        oauthClientIdConfigured: true,
      },
      deepseek: {
        providerId: 'deepseek',
        authState: 'missing',
        credentialSource: 'env',
        defaultModelId: null,
        credentialTarget: null,
        baseUrl: 'https://api.deepseek.com',
      },
    },
  };
}

function createTalkServicePair(turnLimit = 2): {
  registryDirectory: string;
  agentA: DesktopTalkService;
  agentB: DesktopTalkService;
  aOutputs: RendererOutputBlock[];
  bOutputs: RendererOutputBlock[];
} {
  const registryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-talk-test-'));
  const aOutputs: RendererOutputBlock[] = [];
  const bOutputs: RendererOutputBlock[] = [];

  const agentA = new DesktopTalkService({
    getRuntimeStatus: () => Promise.resolve(createRuntimeStatus('Agent A')),
    executeInput: async (envelope) => ({
      result: successResult('TASK_COMPLETED', 'ok', { outputSummary: `Agent A saw: ${envelope.inputText}` }),
      blocks: [],
      runtimeStatus: createRuntimeStatus('Agent A'),
    }),
    publishOutput: (block) => {
      aOutputs.push(block);
    },
  }, {
    localPid: 41001,
    registryDirectory,
    turnLimit,
  });

  const agentB = new DesktopTalkService({
    getRuntimeStatus: () => Promise.resolve(createRuntimeStatus('Agent B')),
    executeInput: async (envelope) => ({
      result: successResult('TASK_COMPLETED', 'ok', { outputSummary: `Agent B saw: ${envelope.inputText}` }),
      blocks: [],
      runtimeStatus: createRuntimeStatus('Agent B'),
    }),
    publishOutput: (block) => {
      bOutputs.push(block);
    },
  }, {
    localPid: 41002,
    registryDirectory,
    turnLimit,
  });

  cleanupTasks.push(async () => {
    await agentA.dispose();
    await agentB.dispose();
    fs.rmSync(registryDirectory, { recursive: true, force: true });
  });

  return {
    registryDirectory,
    agentA,
    agentB,
    aOutputs,
    bOutputs,
  };
}

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const cleanup = cleanupTasks.pop();
    await cleanup?.();
  }
});

describe('DesktopTalkService', () => {
  it('pauses at the turn limit and ends for both sides when one side declines to continue', async () => {
    const { agentA, agentB, aOutputs, bOutputs } = createTalkServicePair();

    const startResult = await agentA.handleTalkCommand('/talkto 41002 -m "Initial debugger request"');
    expect(startResult?.ok).toBe(true);

    await waitFor(() => agentB.getState().incomingRequest !== null);
    const incomingRequest = agentB.getState().incomingRequest;
    expect(incomingRequest?.fromPid).toBe(41001);
    expect(incomingRequest?.message).toBe('Initial debugger request');

    await agentB.respondToIncomingRequest({
      conversationId: incomingRequest!.conversationId,
      decision: 'accept',
    });

    await waitFor(() => {
      const stateA = agentA.getState();
      const stateB = agentB.getState();
      return stateA.activeConversation?.continuationPrompt?.roundCount === 2
        && stateB.activeConversation?.continuationPrompt?.roundCount === 2;
    });

    expect(agentA.getState().activeConversation?.peerPid).toBe(41002);
    expect(agentB.getState().activeConversation?.peerPid).toBe(41001);
    expect(aOutputs.some((block) => block.title === 'Talk Pause')).toBe(true);
    expect(bOutputs.some((block) => block.title === 'Talk Pause')).toBe(true);

    await agentA.respondToContinuation({
      conversationId: agentA.getState().activeConversation!.conversationId,
      decision: 'end',
    });

    await waitFor(() => agentA.getState().activeConversation === null && agentB.getState().activeConversation === null);
    expect(aOutputs.some((block) => block.title === 'Talk Ended')).toBe(true);
    expect(bOutputs.some((block) => block.title === 'Talk Ended')).toBe(true);
  });

  it('resumes the conversation when both sides approve continuation', async () => {
    const { agentA, agentB, aOutputs, bOutputs } = createTalkServicePair();

    const startResult = await agentA.handleTalkCommand('/talkto 41002 -m "Resume after pause"');
    expect(startResult?.ok).toBe(true);

    await waitFor(() => agentB.getState().incomingRequest !== null);
    await agentB.respondToIncomingRequest({
      conversationId: agentB.getState().incomingRequest!.conversationId,
      decision: 'accept',
    });

    await waitFor(() => {
      const stateA = agentA.getState();
      const stateB = agentB.getState();
      return stateA.activeConversation?.continuationPrompt?.roundCount === 2
        && stateB.activeConversation?.continuationPrompt?.roundCount === 2;
    });

    await agentA.respondToContinuation({
      conversationId: agentA.getState().activeConversation!.conversationId,
      decision: 'continue',
    });
    await agentB.respondToContinuation({
      conversationId: agentB.getState().activeConversation!.conversationId,
      decision: 'continue',
    });

    await waitFor(() => {
      const stateA = agentA.getState();
      const stateB = agentB.getState();
      return stateA.activeConversation?.continuationPrompt?.roundCount === 4
        && stateB.activeConversation?.continuationPrompt?.roundCount === 4;
    });

    expect(aOutputs.filter((block) => block.title === 'Talk Pause')).toHaveLength(2);
    expect(bOutputs.filter((block) => block.title === 'Talk Pause')).toHaveLength(2);
    expect(agentA.getState().activeConversation?.turnCount).toBe(4);
    expect(agentB.getState().activeConversation?.turnCount).toBe(4);

    await agentA.respondToContinuation({
      conversationId: agentA.getState().activeConversation!.conversationId,
      decision: 'end',
    });

    await waitFor(() => agentA.getState().activeConversation === null && agentB.getState().activeConversation === null);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error('Timed out waiting for condition.');
}