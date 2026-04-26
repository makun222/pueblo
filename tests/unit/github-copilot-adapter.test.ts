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

  it('parses tool calls from the chat response and includes tools in the request body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{
          message: {
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'grep',
                  arguments: JSON.stringify({ pattern: 'task', include: '*.ts' }),
                },
              },
            ],
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const adapter = new GitHubCopilotAdapter({
      token: 'copilot-access-token',
      tokenType: 'copilot-access-token',
      fetchImpl,
    });

    const result = await adapter.runStep({
      modelId: 'copilot-chat',
      messages: [{ role: 'user', content: 'inspect repo' }],
      availableTools: [
        {
          name: 'grep',
          description: 'Search files',
          inputSchema: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
              include: { type: 'string' },
            },
            required: ['pattern'],
            additionalProperties: false,
          },
        },
      ],
    });

    expect(result).toEqual({
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'grep',
      args: { pattern: 'task', include: '*.ts' },
    });

    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(requestBody.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'grep',
          description: 'Search files',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
              include: { type: 'string' },
            },
            required: ['pattern'],
            additionalProperties: false,
          },
        },
      },
    ]);
    expect(requestBody.tool_choice).toBe('auto');
  });

  it('rejects tool calls with invalid arguments', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{
          message: {
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'exec',
                  arguments: JSON.stringify({ command: '' }),
                },
              },
            ],
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const adapter = new GitHubCopilotAdapter({
      token: 'copilot-access-token',
      tokenType: 'copilot-access-token',
      fetchImpl,
    });

    await expect(adapter.runStep({
      modelId: 'copilot-chat',
      messages: [{ role: 'user', content: 'run command' }],
      availableTools: [
        {
          name: 'exec',
          description: 'Run command',
          inputSchema: {
            type: 'object',
            properties: {
              command: { type: 'string' },
            },
            required: ['command'],
            additionalProperties: false,
          },
        },
      ],
    })).rejects.toThrow();
  });

  it('serializes assistant tool calls and tool results with explicit tool metadata', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ message: { content: 'final answer' } }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const adapter = new GitHubCopilotAdapter({
      token: 'copilot-access-token',
      tokenType: 'copilot-access-token',
      fetchImpl,
    });

    await adapter.runStep({
      modelId: 'copilot-chat',
      messages: [
        {
          role: 'assistant',
          content: 'Search files first',
          toolCallId: 'call-1',
          toolName: 'grep',
          toolArgs: { pattern: 'task', include: '*.ts' },
        },
        {
          role: 'tool',
          content: JSON.stringify({ status: 'succeeded', summary: 'Matched 2 files' }),
          toolCallId: 'call-1',
          toolName: 'grep',
        },
      ],
      availableTools: [],
    });

    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(requestBody.messages).toEqual([
      {
        role: 'assistant',
        content: 'Search files first',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'grep',
              arguments: JSON.stringify({ pattern: 'task', include: '*.ts' }),
            },
          },
        ],
      },
      {
        role: 'tool',
        content: JSON.stringify({ status: 'succeeded', summary: 'Matched 2 files' }),
        tool_call_id: 'call-1',
        name: 'grep',
      },
    ]);
  });
});