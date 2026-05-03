import { parentPort, workerData } from 'node:worker_threads';
import { PepeLocalEmbeddingClient } from './pepe-local-embedding-client';
import { PepeSemanticClient } from './pepe-semantic-client';
import { processPepeSessionSnapshot } from './pepe-worker-process';
import type { PepeWorkerData, PepeWorkerRequest, PepeWorkerResponse } from './pepe-worker-protocol';
import { createConfiguredProviderRegistry } from '../providers/provider-registry-factory';

const port = parentPort;
if (!port) {
  throw new Error('Pepe worker requires a parent port.');
}

const data = workerData as PepeWorkerData;
const providerRegistry = createConfiguredProviderRegistry(data.config);
const semanticClient = new PepeSemanticClient(providerRegistry, data.config);
const embeddingClient = new PepeLocalEmbeddingClient(data.config.pepe);

port.on('message', async (message: PepeWorkerRequest) => {
  if (message.type === 'shutdown') {
    process.exit(0);
    return;
  }

  if (message.type !== 'process-session') {
    return;
  }

  try {
    const result = await processPepeSessionSnapshot(message.snapshot, semanticClient, embeddingClient, data.config.pepe);
    const response: PepeWorkerResponse = {
      type: 'process-result',
      requestId: message.requestId,
      result,
    };
    port.postMessage(response);
  } catch (error) {
    const response: PepeWorkerResponse = {
      type: 'process-error',
      requestId: message.requestId,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(response);
  }
});