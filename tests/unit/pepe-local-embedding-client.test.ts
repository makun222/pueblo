import { describe, expect, it } from 'vitest';
import { PepeLocalEmbeddingClient } from '../../src/agent/pepe-local-embedding-client';
import { createTestAppConfig } from '../helpers/test-config';

describe('pepe local embedding client', () => {
  it('uses sentence-transformers runner output when available', async () => {
    const client = new PepeLocalEmbeddingClient(
      createTestAppConfig().pepe,
      async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          vectors: [
            [0.1, 0.2, 0.3],
            [0.4, 0.5, 0.6],
          ],
        }),
        stderr: '',
      }),
    );

    const batch = await client.embedTexts(['text-a', 'text-b']);

    expect(batch.vectorVersion).toBe('sentence-transformers:all-MiniLM-L6-v2');
    expect(batch.vectors).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
  });

  it('falls back to local hash embeddings when sentence-transformers is unavailable', async () => {
    const client = new PepeLocalEmbeddingClient(
      createTestAppConfig().pepe,
      async () => {
        throw new Error('python unavailable');
      },
    );

    const batch = await client.embedTexts(['sqlite persistence']);

    expect(batch.vectorVersion).toBe('pepe-local-hash-v1');
    expect(batch.vectors).toHaveLength(1);
    expect(batch.vectors[0]?.length).toBeGreaterThan(10);
  });
});