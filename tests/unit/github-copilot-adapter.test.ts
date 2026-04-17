import { describe, expect, it, vi } from 'vitest';
import { GitHubCopilotAdapter } from '../../src/providers/github-copilot-adapter';

describe('github copilot adapter', () => {
  it('fails fast when token is missing', async () => {
    const adapter = new GitHubCopilotAdapter({
      token: '',
      fetchImpl: vi.fn(),
    });

    await expect(adapter.runTask({
      modelId: 'copilot-chat',
      goal: 'inspect repo',
      inputContextSummary: 'test',
    })).rejects.toThrow('GitHub Copilot token is missing');
  });

  it('reuses cached exchanged token across multiple requests', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'cached-access-token', expires_at: Math.floor(Date.now() / 1000) + 600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [{ message: { content: 'first response' } }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [{ message: { content: 'second response' } }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const adapter = new GitHubCopilotAdapter({
      token: 'gho_exchange_token',
      tokenType: 'github-auth-token',
      fetchImpl,
    });

    const first = await adapter.runTask({
      modelId: 'copilot-chat',
      goal: 'first',
      inputContextSummary: 'test',
    });
    const second = await adapter.runTask({
      modelId: 'copilot-chat',
      goal: 'second',
      inputContextSummary: 'test',
    });

    expect(first.outputSummary).toBe('first response');
    expect(second.outputSummary).toBe('second response');
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://api.github.com/copilot_internal/v2/token');
  });

  it('throws when chat payload has no usable message content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: [] } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const adapter = new GitHubCopilotAdapter({
      token: 'copilot-access-token',
      tokenType: 'copilot-access-token',
      fetchImpl,
    });

    await expect(adapter.runTask({
      modelId: 'copilot-chat',
      goal: 'inspect repo',
      inputContextSummary: 'test',
    })).rejects.toThrow('did not include message content');
  });
});