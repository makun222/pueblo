import { describe, expect, it } from 'vitest';
import { agentInstanceSchema } from '../../src/shared/schema';

describe('agent instance schema compatibility', () => {
  it('normalizes missing default flag to false for legacy agent records', () => {
    const agentInstance = agentInstanceSchema.parse({
      id: 'agent-1',
      profileId: 'code-master',
      profileName: 'Code Master',
      status: 'ready',
      workspaceRoot: 'd:/workspace/trends/pueblo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      terminatedAt: null,
    });

    expect(agentInstance.isDefaultForProfile).toBe(false);
  });
});