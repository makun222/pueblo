import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PepeConfig } from '../shared/config';
import { cosineSimilarity, vectorizeWithLocalHash } from './pepe-result-ranking';

export const LOCAL_HASH_VECTOR_VERSION = 'pepe-local-hash-v1';

interface PythonRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface EmbeddingBatch {
  readonly vectors: number[][];
  readonly vectorVersion: string;
}

export type PythonEmbeddingRunner = (args: {
  readonly pythonCommand: string;
  readonly scriptPath: string;
  readonly modelName: string;
  readonly texts: string[];
}) => Promise<PythonRunResult>;

export class PepeLocalEmbeddingClient {
  constructor(
    private readonly config: Pick<PepeConfig, 'embeddingBackend' | 'localEmbeddingModel' | 'pythonCommand'>,
    private readonly runner: PythonEmbeddingRunner = defaultPythonEmbeddingRunner,
  ) {}

  async embedTexts(texts: string[]): Promise<EmbeddingBatch> {
    if (texts.length === 0) {
      return {
        vectors: [],
        vectorVersion: LOCAL_HASH_VECTOR_VERSION,
      };
    }

    if (this.config.embeddingBackend === 'local-hash') {
      return this.embedWithLocalHash(texts);
    }

    try {
      const runResult = await this.runner({
        pythonCommand: this.config.pythonCommand,
        scriptPath: resolvePythonScriptPath(),
        modelName: this.config.localEmbeddingModel,
        texts,
      });

      if (runResult.exitCode !== 0) {
        throw new Error(runResult.stderr || `Embedding process exited with code ${runResult.exitCode}`);
      }

      const parsed = JSON.parse(runResult.stdout) as { vectors?: unknown };
      if (!Array.isArray(parsed.vectors) || parsed.vectors.length !== texts.length) {
        throw new Error('Embedding process returned an invalid vectors payload.');
      }

      const vectors = parsed.vectors.map((vector) => normalizePythonVector(vector));
      return {
        vectors,
        vectorVersion: `sentence-transformers:${this.config.localEmbeddingModel}`,
      };
    } catch {
      return this.embedWithLocalHash(texts);
    }
  }

  private embedWithLocalHash(texts: string[]): EmbeddingBatch {
    return {
      vectors: texts.map((text) => vectorizeWithLocalHash(text)),
      vectorVersion: LOCAL_HASH_VECTOR_VERSION,
    };
  }
}

export { cosineSimilarity };

function normalizePythonVector(vector: unknown): number[] {
  if (!Array.isArray(vector)) {
    throw new Error('Embedding vector payload must be an array.');
  }

  return vector.map((value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error('Embedding vector contains a non-numeric value.');
    }

    return numeric;
  });
}

function resolvePythonScriptPath(): string {
  const candidates = [
    path.resolve(__dirname, 'pepe-local-embedding.py'),
    path.resolve(__dirname, '../../../src/agent/pepe-local-embedding.py'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to locate pepe-local-embedding.py');
}

async function defaultPythonEmbeddingRunner(args: {
  readonly pythonCommand: string;
  readonly scriptPath: string;
  readonly modelName: string;
  readonly texts: string[];
}): Promise<PythonRunResult> {
  return await new Promise<PythonRunResult>((resolve, reject) => {
    const child = spawn(args.pythonCommand, [args.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? -1,
        stdout,
        stderr,
      });
    });

    child.stdin.write(JSON.stringify({
      model: args.modelName,
      texts: args.texts,
    }));
    child.stdin.end();
  });
}