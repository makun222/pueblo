import { describe, expect, it } from 'vitest';
import type { MemoryRecord } from '../../src/shared/schema';
import { rankMemoryCandidatesWithVectors } from '../../src/agent/pepe-result-ranking';

describe('pepe result ranking', () => {
  it('retains sticky memories when they are still reasonably close to the current topic', async () => {
    const memories = [
      createMemoryRecord('memory-politics', '国际政治讨论'),
      createMemoryRecord('memory-code', '编程优化记录'),
    ];

    const ranked = await rankMemoryCandidatesWithVectors({
      memories,
      pendingUserInput: '继续讨论代码优化',
      resultTopK: 4,
      similarityThreshold: 0.8,
      selectedMemoryIds: ['memory-code'],
      vectors: [
        [1, 0],
        [0.1, 0.99],
        [0.65, 0.76],
      ],
      vectorVersion: 'test-vectors',
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.memoryId).toBe('memory-code');
    expect(ranked[0]?.similarity).toBe(0.65);
  });

  it('falls back to the single best semantic match instead of flooding the result set', async () => {
    const memories = [
      createMemoryRecord('memory-best', '编程优化'),
      createMemoryRecord('memory-weaker', '国际政治'),
    ];

    const ranked = await rankMemoryCandidatesWithVectors({
      memories,
      pendingUserInput: '优化数据库查询',
      resultTopK: 8,
      similarityThreshold: 0.8,
      vectors: [
        [1, 0],
        [0.4, 0.92],
        [0.2, 0.98],
      ],
      vectorVersion: 'test-vectors',
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.memoryId).toBe('memory-best');
    expect(ranked[0]?.similarity).toBe(0.4);
  });

  it('only keeps recent selected memories sticky, not the entire historical chain', async () => {
    const memories = [
      createMemoryRecord('memory-stale', '旧主题'),
      createMemoryRecord('memory-filler-1', '填充1'),
      createMemoryRecord('memory-filler-2', '填充2'),
      createMemoryRecord('memory-filler-3', '填充3'),
      createMemoryRecord('memory-filler-4', '填充4'),
      createMemoryRecord('memory-filler-5', '填充5'),
      createMemoryRecord('memory-recent', '当前主题'),
    ];

    const ranked = await rankMemoryCandidatesWithVectors({
      memories,
      pendingUserInput: '继续当前主题',
      resultTopK: 4,
      similarityThreshold: 0.8,
      selectedMemoryIds: [
        'memory-stale',
        'memory-filler-1',
        'memory-filler-2',
        'memory-filler-3',
        'memory-filler-4',
        'memory-filler-5',
        'memory-recent',
      ],
      vectors: [
        [1, 0],
        [0.65, 0.76],
        [0.02, 1],
        [0.02, 1],
        [0.02, 1],
        [0.02, 1],
        [0.02, 1],
        [0.65, 0.76],
      ],
      vectorVersion: 'test-vectors',
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.memoryId).toBe('memory-recent');
    expect(ranked.some((item) => item.memoryId === 'memory-stale')).toBe(false);
  });
});

function createMemoryRecord(id: string, title: string): MemoryRecord {
  const timestamp = '2026-04-30T00:00:00.000Z';
  return {
    id,
    type: 'short-term',
    title,
    content: `${title} 内容`,
    scope: 'session',
    status: 'active',
    tags: ['conversation-turn'],
    parentId: null,
    derivationType: 'manual',
    summaryDepth: 0,
    sourceSessionId: 'session-1',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}