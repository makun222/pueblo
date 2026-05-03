import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextResolver } from '../../src/agent/context-resolver';
import { InMemoryAgentInstanceRepository } from '../../src/agent/agent-instance-repository';
import { AgentInstanceService } from '../../src/agent/agent-instance-service';
import { AgentTemplateLoader } from '../../src/agent/agent-template-loader';
import { PepeResultService } from '../../src/agent/pepe-result-service';
import { MemoryService } from '../../src/memory/memory-service';
import { InMemoryMemoryRepository } from '../../src/memory/memory-repository';
import { PromptService } from '../../src/prompts/prompt-service';
import { InMemoryPromptRepository } from '../../src/prompts/prompt-repository';
import { InMemoryProviderAdapter } from '../../src/providers/provider-adapter';
import { createProviderProfile } from '../../src/providers/provider-profile';
import { ProviderRegistry } from '../../src/providers/provider-registry';
import { InMemorySessionRepository } from '../../src/sessions/session-repository';
import { SessionService } from '../../src/sessions/session-service';
import { createTestAppConfig } from '../helpers/test-config';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('context resolver', () => {
  it('resolves pueblo profile, session-backed selections, and result-backed context counts', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-resolver-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');
    fs.writeFileSync(path.join(tempDir, 'pueblo.md'), '# Role\n- focused agent\n# Summary Policy\n- Auto summarize near 75 percent\n');
    fs.mkdirSync(path.join(tempDir, 'puebl-profile', 'code-master'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'puebl-profile', 'code-master', 'agent.md'),
      [
        '# Profile',
        '- id: code-master',
        '- name: Code Master',
        '- description: Focused on shipping correct code changes with strong validation discipline.',
        '',
        '# Role',
        '- Act as a pragmatic senior software engineer.',
        '',
        '# Goals',
        '- Produce correct, testable code changes.',
        '',
        '# Constraints',
        '- Do not change unrelated behavior.',
        '',
        '# Style',
        '- Be concise, technical, and direct.',
        '',
        '# Memory Policy',
        '- Retain task-relevant implementation decisions as reusable memories.',
        '- Summary: Summarize completed code turns into compact reusable engineering notes.',
        '',
        '# Context Policy',
        '- Prioritize current code goal, selected memories, and active constraints.',
        '- Truncate: Drop stale conversational history before dropping explicit task memories.',
        '',
        '# Summary Policy',
        '- Auto summarize',
        '- Threshold: 12000',
        '- Lineage: Preserve engineering decisions as reusable session memories.',
        '',
      ].join('\n'),
    );

    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository());
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 16000 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const session = sessionService.createSession('Resolver session', 'gpt-4.1-mini');
    const prompt = promptService.createPrompt('Root cause', 'analysis', 'Always inspect the root cause first.');
    const memory = memoryService.createMemory('Repo fact', 'This repository uses sqlite persistence.', 'project');
    sessionService.addUserMessage(session.id, 'Inspect the failing workflow');
    sessionService.addAssistantMessage(session.id, 'I will inspect the failing workflow.');
    sessionService.addSelectedPrompt(session.id, prompt.id);
    sessionService.addSelectedMemory(session.id, memory.id);
    const pepeResultService = new PepeResultService(memoryService, createTestAppConfig({ defaultProviderId: 'openai' }).pepe);
    pepeResultService.cacheSessionResult({
      sessionId: session.id,
      agentInstanceId: null,
      selectedMemoryIds: [memory.id],
      pendingUserInput: 'Inspect the failing workflow',
      resultItems: [
        {
          memoryId: memory.id,
          summary: 'Cached result: sqlite persistence is relevant.',
          similarity: 0.99,
          sourceSessionId: null,
          vectorVersion: 'pepe-local-v1',
        },
      ],
    });

    const resolver = new ContextResolver({
      config: createTestAppConfig({ defaultProviderId: 'openai' }),
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService,
    });
    const resolved = resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: 'Inspect the failing workflow',
      cwd: tempDir,
    });

    expect(resolved.taskContext.puebloProfile.roleDirectives).toContain('focused agent');
    expect(resolved.taskContext.selectedPromptIds).toEqual([prompt.id]);
    expect(resolved.taskContext.selectedMemoryIds).toEqual([memory.id]);
    expect(resolved.taskContext.resultSet?.sessionId).toBe(session.id);
    expect(resolved.taskContext.targetDirectory).toBeNull();
    expect(resolved.taskContext.resultItems).toHaveLength(1);
    expect(resolved.taskContext.resultItems[0]?.memoryId).toBe(memory.id);
    expect(resolved.taskContext.resultItems[0]?.summary).toContain('Cached result');
    expect(resolved.taskContext.sessionMessages).toHaveLength(2);
    expect(resolved.taskContext.recentMessages).toEqual([
      'User: Inspect the failing workflow',
      'Assistant: I will inspect the failing workflow.',
    ]);
    expect(resolved.runtimeStatus.activeSessionId).toBe(session.id);
    expect(resolved.runtimeStatus.agentProfileId).toBe('code-master');
    expect(resolved.runtimeStatus.selectedPromptCount).toBe(1);
    expect(resolved.runtimeStatus.selectedMemoryCount).toBe(1);
    expect(resolved.runtimeStatus.contextCount.messageCount).toBe(2);
    expect(resolved.runtimeStatus.contextCount.estimatedTokens).toBeGreaterThan(0);
    expect(resolved.runtimeStatus.contextCount.contextWindowLimit).toBe(16000);
  });

  it('extracts the target directory from the latest user path when the new turn omits it', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-target-dir-'));
    tempDirs.push(tempDir);
    const externalRepoDir = path.join(tempDir, 'external-repo');
    fs.mkdirSync(externalRepoDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');

    const sessionService = new SessionService(new InMemorySessionRepository());
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository());
    const agentInstanceService = new AgentInstanceService(new InMemoryAgentInstanceRepository(), new AgentTemplateLoader(tempDir));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true, contextWindow: 16000 }],
      }),
      new InMemoryProviderAdapter('openai', 'Task completed'),
    );

    const session = sessionService.createSession('Resolver session', 'gpt-4.1-mini');
    sessionService.addUserMessage(session.id, `${externalRepoDir}，解析一下这个地址的项目。`);
    sessionService.addAssistantMessage(session.id, 'I will inspect that repository.');

    const resolver = new ContextResolver({
      config: createTestAppConfig({ defaultProviderId: 'openai' }),
      sessionService,
      promptService,
      memoryService,
      agentInstanceService,
      providerRegistry,
      pepeResultService: new PepeResultService(memoryService, createTestAppConfig({ defaultProviderId: 'openai' }).pepe),
    });

    const resolved = resolver.resolve({
      activeSessionId: session.id,
      pendingUserInput: '继续分析 source code',
      cwd: tempDir,
    });

    expect(resolved.taskContext.targetDirectory).toBe(externalRepoDir);
  });
});