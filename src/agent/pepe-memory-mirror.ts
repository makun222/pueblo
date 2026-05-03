import fs from 'node:fs';
import path from 'node:path';
import type { PepeConfig } from '../shared/config';
import type { MemoryRecord, PepeResultSet } from '../shared/schema';

export interface FlushPepeMemoryMirrorInput {
  readonly agentInstanceId: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly memories: MemoryRecord[];
  readonly resultSet: PepeResultSet | null;
}

export class PepeMemoryMirror {
  constructor(private readonly config: Pick<PepeConfig, 'workingDirectoryPattern'>) {}

  flush(input: FlushPepeMemoryMirrorInput): void {
    const memoryDirectory = this.resolveMemoryDirectory(input.workspaceRoot, input.agentInstanceId);
    fs.mkdirSync(memoryDirectory, { recursive: true });

    const manifest = {
      agentInstanceId: input.agentInstanceId,
      sessionId: input.sessionId,
      memoryCount: input.memories.length,
      resultCount: input.resultSet?.items.length ?? 0,
      syncedAt: new Date().toISOString(),
      version: 1,
    };

    writeJsonAtomically(path.join(memoryDirectory, 'manifest.json'), manifest);
    writeJsonAtomically(
      path.join(memoryDirectory, 'vector-index.json'),
      {
        sessionId: input.sessionId,
        updatedAt: new Date().toISOString(),
        items: input.resultSet?.items.map((item) => ({
          memoryId: item.memoryId,
          similarity: item.similarity,
          vectorVersion: item.vectorVersion,
        })) ?? [],
      },
    );

    if (input.resultSet) {
      writeJsonAtomically(path.join(memoryDirectory, 'result-set.json'), input.resultSet);
    }

    for (const memory of input.memories) {
      writeJsonAtomically(path.join(memoryDirectory, `${resolveMemoryFileName(memory)}.json`), memory);
    }
  }

  private resolveMemoryDirectory(workspaceRoot: string, agentInstanceId: string): string {
    const agentDirectoryName = this.config.workingDirectoryPattern.replace('{agentInstanceId}', agentInstanceId);
    return path.join(workspaceRoot, agentDirectoryName, '.memory');
  }
}

function resolveMemoryFileName(memory: MemoryRecord): string {
  if (memory.tags.includes('pepe-summary') || memory.parentId) {
    return `summary-${memory.id}`;
  }

  const prefix = memory.tags.includes('conversation-turn') ? 'turn' : 'memory';
  return `${prefix}-${memory.id}`;
}

function writeJsonAtomically(targetPath: string, value: unknown): void {
  const tempPath = `${targetPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { force: true });
  }
  fs.renameSync(tempPath, targetPath);
}