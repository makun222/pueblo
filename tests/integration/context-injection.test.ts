import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PepeConfig } from '../../src/shared/config';
import { createCliDependencies } from '../../src/cli/index';
import { createTestAppConfig } from '../helpers/test-config';
import { nodeSqliteAvailable } from '../helpers/sqlite-runtime';
import { extractTaskOutputSummaryPayload } from '../../src/shared/result';
import type { PepeLocalEmbeddingClient } from '../../src/agent/pepe-local-embedding-client';
import { processPepeSessionSnapshot } from '../../src/agent/pepe-worker-process';
import type { PepeWorkerData, PepeWorkerRequest, PepeWorkerResponse } from '../../src/agent/pepe-worker-protocol';
import { PepeSemanticClient } from '../../src/agent/pepe-semantic-client';
import { createConfiguredProviderRegistry } from '../../src/providers/provider-registry-factory';

const tempDirs: string[] = [];
let previousCwd = process.cwd();

beforeEach(() => {
	previousCwd = process.cwd();
});

afterEach(() => {
	process.chdir(previousCwd);

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();

    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

const describeIfNodeSqlite = nodeSqliteAvailable ? describe : describe.skip;

describeIfNodeSqlite('context injection integration', () => {
  it('injects selected prompt and memory into task execution context', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-injection-'));
    tempDirs.push(tempDir);

    const config = createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      defaultProviderId: 'openai',
      defaultSessionId: null,
      providers: [{ providerId: 'openai', defaultModelId: 'gpt-4.1-mini', enabled: true, credentialSource: 'env' }],
    });

    const cli = createCliDependencies(config);

    try {
      await cli.dispatcher.dispatch({ input: '/new context task' });
      const prompt = await cli.dispatcher.dispatch({ input: '/prompt-add bugfix Analyze root cause first' });
      const memory = await cli.dispatcher.dispatch({ input: '/memory-add session Repo uses sqlite session' });
      await cli.dispatcher.dispatch({ input: `/prompt-sel ${(prompt.data as { id: string }).id}` });
      await cli.dispatcher.dispatch({ input: `/memory-sel ${(memory.data as { id: string }).id}` });
      const result = await cli.dispatcher.dispatch({ input: '/task-run inspect current bug' });

      expect(result.ok).toBe(true);
      expect(JSON.stringify(result.data)).toContain('promptIds');
      expect(JSON.stringify(result.data)).toContain('memoryIds');
      expect(JSON.stringify(result.data)).toContain('toolResults');
    } finally {
      cli.databaseClose();
    }
  });

  it('keeps workflow memory IDs in task metadata even when Pepe result items do not carry them', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-injection-workflow-'));
    tempDirs.push(tempDir);
    process.chdir(tempDir);

    const config = createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      defaultProviderId: 'openai',
      defaultSessionId: null,
      pepe: { enabled: true, embeddingBackend: 'local-hash', providerId: 'openai', modelId: 'gpt-4.1-mini' },
      workflow: {
        runtimeDirectory: path.join(tempDir, '.plans'),
      },
      providers: [{ providerId: 'openai', defaultModelId: 'gpt-4.1-mini', enabled: true, credentialSource: 'env' }],
    });

    const providerRegistry = createConfiguredProviderRegistry(config);
    const cli = createCliDependencies(config, {
      pepeWorkerFactory: (data) => createFakePepeWorker(
        data,
        new PepeSemanticClient(providerRegistry, config),
        createStaticEmbeddingClient(),
        config.pepe,
      ),
    });

    try {
      const start = await cli.dispatcher.dispatch({ input: '/workflow preserve workflow metadata in task output' });
      expect(start.ok).toBe(true);
      const startData = start.data as {
        sessionId: string;
        planMemoryId: string;
        todoMemoryId: string | null;
      };
      expect(startData.todoMemoryId).toBeTruthy();

      const result = await cli.dispatcher.dispatch({ input: '/task-run continue the active workflow' });
      expect(result.ok).toBe(true);

      const payload = extractTaskOutputSummaryPayload(
        result.data && typeof result.data === 'object' && 'outputSummary' in result.data
          ? String((result.data as { outputSummary?: string | null }).outputSummary ?? '')
          : null,
      );

      expect(payload?.workflow?.workflowId).toBeTruthy();
      expect(payload?.attribution?.memoryIds).toContain(startData.planMemoryId);
      expect(payload?.attribution?.memoryIds).toContain(startData.todoMemoryId!);
    } finally {
      cli.databaseClose();
    }
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
          if (normalized.includes('workflow') || normalized.includes('plan')) {
            return [1, 0, 0];
          }

          return [0, 1, 0];
        }),
      };
    },
  };
}
