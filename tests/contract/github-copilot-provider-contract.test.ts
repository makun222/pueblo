import { describe, expect, it, vi } from 'vitest';
import { GitHubCopilotAdapter } from '../../src/providers/github-copilot-adapter';
import { getToolExecutionPolicy, providerEditToolInputSchema } from '../../src/providers/provider-adapter';
import { resolveGitHubCopilotAuth } from '../../src/providers/github-copilot-auth';
import { createGitHubCopilotProfile } from '../../src/providers/github-copilot-profile';
import type { ProviderAdapter } from '../../src/providers/provider-adapter';
import { createTestAppConfig } from '../helpers/test-config';

describe('GitHub Copilot Provider Contract', () => {
  it('should implement ProviderAdapter interface', () => {
    const adapter: ProviderAdapter = new GitHubCopilotAdapter({
      token: 'copilot-token',
      tokenType: 'copilot-access-token',
      fetchImpl: vi.fn(),
    });

    const profile = createGitHubCopilotProfile('configured');

    expect(adapter).toBeInstanceOf(GitHubCopilotAdapter);
    expect(profile.id).toBe('github-copilot');
    expect(profile.defaultModelId).toBe('copilot-chat');
  });

  it('should handle task execution requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: 'Copilot output',
            },
          },
        ],
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    const adapter = new GitHubCopilotAdapter({
      token: 'copilot-token',
      tokenType: 'copilot-access-token',
      fetchImpl,
    });

    const result = await adapter.runTask({
      modelId: 'copilot-chat',
      goal: 'Inspect repository state',
      inputContextSummary: 'Task execution test',
    });

    expect(result.outputSummary).toBe('Copilot output');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('should stream GitHub Copilot final text deltas through the step callback', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":" from Copilot"}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
        },
      }),
    );
    const adapter = new GitHubCopilotAdapter({
      token: 'copilot-token',
      tokenType: 'copilot-access-token',
      fetchImpl,
    });

    const streamedText: string[] = [];
    const result = await adapter.runStep({
      modelId: 'copilot-chat',
      messages: [{ role: 'user', content: 'Say hello.' }],
      availableTools: [],
      onTextDelta: (text) => {
        streamedText.push(text);
      },
    });

    expect(result).toEqual({
      type: 'final',
      outputSummary: 'Hello from Copilot',
    });
    expect(streamedText).toEqual(['Hello', ' from Copilot']);
  });

  it('should validate GitHub Copilot credentials', () => {
    const config = createTestAppConfig({
      providers: [
        {
          providerId: 'github-copilot',
          defaultModelId: 'copilot-chat',
          enabled: true,
          credentialSource: 'env',
        },
      ],
      githubCopilot: {
        apiUrl: 'https://api.githubcopilot.com/chat/completions',
        exchangeUrl: 'https://api.github.com/copilot_internal/v2/token',
        tokenType: 'copilot-access-token',
        token: 'copilot-token',
        userAgent: 'Pueblo/0.1.0',
        editorVersion: 'vscode/1.99.0',
        editorPluginVersion: 'copilot-chat/0.43.0',
        integrationId: 'vscode-chat',
      },
    });

    expect(resolveGitHubCopilotAuth(config).authState).toBe('configured');
  });

  it('should call chat completions directly with a GitHub auth token', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'Exchanged token output',
              },
            },
          ],
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      );

    const adapter = new GitHubCopilotAdapter({
      token: 'gho_exchange_token',
      tokenType: 'github-auth-token',
      fetchImpl,
    });

    const result = await adapter.runTask({
      modelId: 'copilot-chat',
      goal: 'Inspect repository state',
      inputContextSummary: 'Task execution test',
    });

    expect(result.outputSummary).toBe('Exchanged token output');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.githubcopilot.com/chat/completions');
  });

  it('should fall back to exchange when direct GitHub auth token chat access is rejected', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Unauthorized' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'copilot-access-token', expires_at: Math.floor(Date.now() / 1000) + 600 }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'Fallback exchange output',
              },
            },
          ],
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      );

    const adapter = new GitHubCopilotAdapter({
      token: 'gho_exchange_token',
      tokenType: 'github-auth-token',
      fetchImpl,
    });

    const result = await adapter.runTask({
      modelId: 'copilot-chat',
      goal: 'Inspect repository state',
      inputContextSummary: 'Task execution test',
    });

    expect(result.outputSummary).toBe('Fallback exchange output');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.githubcopilot.com/chat/completions');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://api.github.com/copilot_internal/v2/token');
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('https://api.githubcopilot.com/chat/completions');
  });

  it('should reject personal access tokens with a clear local error', async () => {
    const adapter = new GitHubCopilotAdapter({
      token: 'ghp_example_personal_access_token',
      tokenType: 'github-pat',
      fetchImpl: vi.fn(),
    });

    await expect(adapter.runTask({
      modelId: 'copilot-chat',
      goal: 'Inspect repository state',
      inputContextSummary: 'Task execution test',
    })).rejects.toThrow('Personal Access Tokens are not supported');
  });

  it('should surface tool-call responses through the step API', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'glob',
                    arguments: JSON.stringify({ pattern: 'src/**/*.ts' }),
                  },
                },
              ],
            },
          },
        ],
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    const adapter = new GitHubCopilotAdapter({
      token: 'copilot-token',
      tokenType: 'copilot-access-token',
      fetchImpl,
    });

    const result = await adapter.runStep({
      modelId: 'copilot-chat',
      messages: [{ role: 'user', content: 'Inspect repository state' }],
      availableTools: [
        {
          name: 'glob',
          description: 'Match files',
          executionPolicy: getToolExecutionPolicy('glob'),
          inputSchema: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
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
      toolName: 'glob',
      args: { pattern: 'src/**/*.ts' },
    });
  });

  it('should accept legacy write tool calls and map them to edit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: 'I can write the file now.',
              tool_calls: [
                {
                  id: 'call-write-1',
                  type: 'function',
                  function: {
                    name: 'write',
                    arguments: JSON.stringify({
                      path: 'src/example.ts',
                      content: 'export const value = 1;\n',
                    }),
                  },
                },
              ],
            },
          },
        ],
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    const adapter = new GitHubCopilotAdapter({
      token: 'copilot-token',
      tokenType: 'copilot-access-token',
      fetchImpl,
    });

    const result = await adapter.runStep({
      modelId: 'copilot-chat',
      messages: [{ role: 'user', content: 'Create src/example.ts.' }],
      availableTools: [
        {
          name: 'edit',
          description: 'Edit a file',
          executionPolicy: getToolExecutionPolicy('edit'),
          inputSchema: providerEditToolInputSchema,
        },
      ],
    });

    expect(result).toEqual({
      type: 'tool-call',
      toolCallId: 'call-write-1',
      toolName: 'edit',
      args: {
        path: 'src/example.ts',
        oldText: '',
        newText: 'export const value = 1;\n',
      },
    });
  });
});