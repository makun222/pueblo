import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PepeConfig } from '../../src/shared/config';
import type { PepeLocalEmbeddingClient } from '../../src/agent/pepe-local-embedding-client';
import { PepeResultService } from '../../src/agent/pepe-result-service';
import { PepeSemanticClient } from '../../src/agent/pepe-semantic-client';
import { PepeSupervisor } from '../../src/agent/pepe-supervisor';
import { processPepeSessionSnapshot } from '../../src/agent/pepe-worker-process';
import type { PepeWorkerData, PepeWorkerRequest, PepeWorkerResponse } from '../../src/agent/pepe-worker-protocol';
import { MemoryService } from '../../src/memory/memory-service';
import { InMemoryMemoryRepository } from '../../src/memory/memory-repository';
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

describe('pepe supervisor', () => {
  it('creates derived summary memories through the semantic client and mirrors them to disk', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-pepe-supervisor-'));
    tempDirs.push(tempDir);

    const config = createTestAppConfig({
      pepe: {
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
        embeddingBackend: 'local-hash',
      },
    });
    const memoryService = new MemoryService(new InMemoryMemoryRepository());
    const sessionService = new SessionService(new InMemorySessionRepository(), memoryService);
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
      }),
      new InMemoryProviderAdapter('openai', 'Semantic summary'),
    );

    const session = sessionService.createSession('Summary session', 'gpt-4.1-mini', 'agent-1');
    const turnMemory = memoryService.createConversationTurnMemory({
      sessionId: session.id,
      turnNumber: 1,
      userInput: 'Investigate sqlite persistence',
      assistantOutput: 'SQLite is the authoritative store.',
    });
    sessionService.addSelectedMemory(session.id, turnMemory.id);

    const supervisor = new PepeSupervisor({
      config: config.pepe,
      memoryService,
      sessionService,
      appConfig: config,
      agentInstanceService: {
        getAgentInstance: (agentInstanceId) => agentInstanceId === 'agent-1'
          ? {
              id: 'agent-1',
              profileId: 'code-master',
              profileName: 'Code Master',
              status: 'active',
              workspaceRoot: tempDir,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              terminatedAt: null,
            }
          : null,
      },
      resultService: new PepeResultService(memoryService, config.pepe),
      workerFactory: (data) => createFakePepeWorker(
        data,
        new PepeSemanticClient(providerRegistry, config),
        createStaticEmbeddingClient(),
        config.pepe,
      ),
    });

    supervisor.startSession(session.id);
    supervisor.recordInput(session.id, 'Investigate sqlite persistence');
    await supervisor.flushSession(session.id);

    const sessionMemories = memoryService.listSessionMemories(session.id);
    const summaryMemory = sessionMemories.find((memory) => memory.tags.includes('pepe-summary'));
    expect(summaryMemory).toBeTruthy();
    expect(summaryMemory?.parentId).toBe(turnMemory.id);
    expect(sessionService.getSession(session.id)?.selectedMemoryIds).toContain(summaryMemory?.id);

    const mirrorDirectory = path.join(tempDir, 'agent-agent-1', '.memory');
    const summaryFile = fs.readdirSync(mirrorDirectory).find((fileName) => fileName.startsWith('summary-'));
    expect(summaryFile).toBeTruthy();

    supervisor.stopAll();
  });
});

function createFakePepeWorker(
  data: PepeWorkerData,
  semanticClient: PepeSemanticClient,
  embeddingClient: Pick<PepeLocalEmbeddingClient, 'embedTexts'>,
  config: Pick<PepeConfig, 'resultTopK' | 'similarityThreshold'>,
) {
  let messageHandler: ((message: PepeWorkerResponse) => void) | null = null;
  let errorHandler: ((error: Error) => void) | null = null;

  return {
    postMessage(message: PepeWorkerRequest) {
      if (message.type === 'shutdown') {
        return;
      }

      void processPepeSessionSnapshot(message.snapshot, semanticClient, embeddingClient, config)
        .then((result) => {
          messageHandler?.({
            type: 'process-result',
            requestId: message.requestId,
            result,
          });
        })
        .catch((error) => {
          const normalizedError = error instanceof Error ? error : new Error(String(error));
          if (errorHandler) {
            errorHandler(normalizedError);
            return;
          }

          messageHandler?.({
            type: 'process-error',
            requestId: message.requestId,
            errorMessage: normalizedError.message,
          });
        });
    },
    on(event: 'message' | 'error', listener: ((message: PepeWorkerResponse) => void) | ((error: Error) => void)) {
      if (event === 'message') {
        messageHandler = listener as (message: PepeWorkerResponse) => void;
      } else {
        errorHandler = listener as (error: Error) => void;
      }

      return this;
    },
    async terminate() {
      return 0;
    },
  };
}

function createStaticEmbeddingClient(): Pick<PepeLocalEmbeddingClient, 'embedTexts'> {
  return {
    async embedTexts(texts: string[]) {
      return {
        vectorVersion: 'test-static-v1',
        vectors: texts.map((text) => {
          const normalized = text.toLowerCase();
          return normalized.includes('sqlite') ? [1, 0, 0] : [0, 1, 0];
        }),
      };
    },
  };
}