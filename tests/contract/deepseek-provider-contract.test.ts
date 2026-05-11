import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DeepSeekAdapter } from '../../src/providers/deepseek-adapter';
import { resolveDeepSeekAuth } from '../../src/providers/deepseek-auth';
import { createDeepSeekProfile } from '../../src/providers/deepseek-profile';
import {
  providerEditToolInputSchema,
  getToolExecutionPolicy,
  providerGlobToolInputSchema,
  providerReadToolInputSchema,
  type ProviderAdapter,
  type ProviderStepContext,
} from '../../src/providers/provider-adapter';
import { createTestAppConfig } from '../helpers/test-config';

describe('DeepSeek Provider Contract', () => {
  it('should implement ProviderAdapter interface', () => {
    const adapter: ProviderAdapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      fetchImpl: vi.fn(),
    });

    const profile = createDeepSeekProfile('configured');

    expect(adapter).toBeInstanceOf(DeepSeekAdapter);
    expect(profile.id).toBe('deepseek');
    expect(profile.defaultModelId).toBe('deepseek-v4-flash');
  });

  it('should preserve DeepSeek usage fields on task execution responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: 'DeepSeek output',
            },
          },
        ],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 45,
          total_tokens: 165,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 40,
        },
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    const adapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl,
    });

    const result = await adapter.runTask({
      modelId: 'deepseek-v4-flash',
      goal: 'Inspect repository state',
      inputContextSummary: 'Task execution test',
    });

    expect(result).toMatchObject({
      outputSummary: 'DeepSeek output',
      usage: {
        promptTokens: 120,
        completionTokens: 45,
        totalTokens: 165,
        promptCacheHitTokens: 80,
        promptCacheMissTokens: 40,
      },
    });
  });

  it('should handle task execution requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: 'DeepSeek output',
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
    const adapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl,
    });

    const result = await adapter.runTask({
      modelId: 'deepseek-v4-flash',
      goal: 'Inspect repository state',
      inputContextSummary: 'Task execution test',
    });

    expect(result.outputSummary).toBe('DeepSeek output');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/chat/completions');
  });

  it('should stream DeepSeek final text deltas through the step callback', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":" world"}}]}',
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
    const adapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl,
    });

    const streamedText: string[] = [];
    const result = await adapter.runStep({
      modelId: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Say hello.' }],
      availableTools: [],
      onTextDelta: (text) => {
        streamedText.push(text);
      },
    });

    expect(result).toEqual({
      type: 'final',
      outputSummary: 'Hello world',
    });
    expect(streamedText).toEqual(['Hello', ' world']);
  });

  it('should preserve DeepSeek usage fields from streaming responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        '',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":120,"completion_tokens":45,"total_tokens":165,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":40}}',
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
    const adapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl,
    });

    const streamedText: string[] = [];
    const result = await adapter.runStep({
      modelId: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Say hello.' }],
      availableTools: [],
      onTextDelta: (text) => {
        streamedText.push(text);
      },
    });

    expect(result).toMatchObject({
      type: 'final',
      outputSummary: 'Hello world',
      usage: {
        promptTokens: 120,
        completionTokens: 45,
        totalTokens: 165,
        promptCacheHitTokens: 80,
        promptCacheMissTokens: 40,
      },
    });
    expect(streamedText).toEqual(['Hello', ' world']);
  });

  it('should validate DeepSeek credentials', () => {
    const config = createTestAppConfig({
      providers: [
        {
          providerId: 'deepseek',
          defaultModelId: 'deepseek-v4-flash',
          enabled: true,
          credentialSource: 'config-file',
        },
      ],
      deepseek: {
        apiKey: 'deepseek-key',
      },
    });

    expect(resolveDeepSeekAuth(config).authState).toBe('configured');
  });

  it('should wrap network fetch failures as provider errors', async () => {
    const adapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    });

    await expect(adapter.runTask({
      modelId: 'deepseek-v4-flash',
      goal: 'Inspect repository state',
      inputContextSummary: 'Task execution test',
    })).rejects.toThrow('DeepSeek network request failed to https://api.deepseek.com/chat/completions: fetch failed');
  });

  it('should write failed DeepSeek response details to the response log directory', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-deepseek-log-'));
    const adapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      logDir,
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          error: {
            message: 'bad request',
            type: 'invalid_request_error',
          },
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    });

    await expect(adapter.runTask({
      modelId: 'deepseek-v4-flash',
      goal: 'Inspect repository state',
      inputContextSummary: 'Task execution test',
    })).rejects.toThrow('DeepSeek request failed (400)');

    const logFiles = fs.readdirSync(logDir);
    expect(logFiles.length).toBe(1);

    const logContent = JSON.parse(fs.readFileSync(path.join(logDir, logFiles[0] ?? ''), 'utf8')) as {
      providerId?: string;
      category?: string;
      status?: number;
      responseText?: string;
    };

    expect(logContent.providerId).toBe('deepseek');
    expect(logContent.category).toBe('http-error');
    expect(logContent.status).toBe(400);
    expect(logContent.responseText).toContain('invalid_request_error');
  });

  it('should replay reasoning_content for tool-call follow-up requests', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'I should inspect files first.',
                reasoning_content: 'Need repository visibility before answering.',
                tool_calls: [
                  {
                    id: 'tool-1',
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
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'Done.',
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

    const adapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl,
    });

    const initialContext: ProviderStepContext = {
      modelId: 'deepseek-v4-pro',
      messages: [
        {
          role: 'system',
          content: 'You are a coding assistant',
        },
        {
          role: 'user',
          content: 'List TypeScript files.',
        },
      ],
      availableTools: [
        {
          name: 'glob',
          description: 'Find files by glob pattern',
          executionPolicy: getToolExecutionPolicy('glob'),
          inputSchema: providerGlobToolInputSchema,
        },
      ],
    };

    const firstStep = await adapter.runStep(initialContext);
    expect(firstStep.type).toBe('tool-call');
    if (firstStep.type !== 'tool-call') {
      throw new Error('Expected tool-call result');
    }

    expect(firstStep.reasoningContent).toBe('Need repository visibility before answering.');

    const followUpContext: ProviderStepContext = {
      modelId: 'deepseek-v4-pro',
      messages: [
        ...initialContext.messages,
        {
          role: 'assistant',
          content: firstStep.rationale ?? 'Requesting tool glob',
          toolCallId: firstStep.toolCallId,
          toolName: firstStep.toolName,
          toolArgs: firstStep.args,
          reasoningContent: firstStep.reasoningContent,
        },
        {
          role: 'tool',
          content: JSON.stringify({ status: 'succeeded', summary: 'Found files', output: ['src/main.ts'] }),
          toolCallId: firstStep.toolCallId,
          toolName: firstStep.toolName,
        },
      ],
      availableTools: initialContext.availableTools,
    };

    await adapter.runStep(followUpContext);

    const secondRequestPayload = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as {
      messages?: Array<{ role?: string; reasoning_content?: string }>;
    };
    const assistantMessage = secondRequestPayload.messages?.find((message) => message.role === 'assistant');

    expect(assistantMessage?.reasoning_content).toBe('Need repository visibility before answering.');
  });

  it('should accept edit tool calls returned by DeepSeek', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: 'I can apply the requested edit now.',
              tool_calls: [
                {
                  id: 'tool-edit-1',
                  type: 'function',
                  function: {
                    name: 'edit',
                    arguments: JSON.stringify({
                      path: 'src/example.ts',
                      oldText: 'alpha',
                      newText: 'beta',
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

    const adapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl,
    });

    const context: ProviderStepContext = {
      modelId: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: 'You are a coding assistant' },
        { role: 'user', content: 'Replace alpha with beta.' },
      ],
      availableTools: [
        {
          name: 'edit',
          description: 'Edit a file',
          executionPolicy: getToolExecutionPolicy('edit'),
          inputSchema: providerEditToolInputSchema,
        },
      ],
    };

    const result = await adapter.runStep(context);

    expect(result.type).toBe('tool-call');
    if (result.type !== 'tool-call') {
      throw new Error('Expected tool-call result');
    }

    expect(result.toolName).toBe('edit');
    expect(result.toolCallId).toBe('tool-edit-1');
    expect(result.args).toEqual({
      path: 'src/example.ts',
      oldText: 'alpha',
      newText: 'beta',
    });
  });

  it('should accept create-file edit tool calls returned by DeepSeek', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: 'I can create the file now.',
              tool_calls: [
                {
                  id: 'tool-edit-create-1',
                  type: 'function',
                  function: {
                    name: 'edit',
                    arguments: JSON.stringify({
                      path: 'src/example.ts',
                      oldText: '',
                      newText: 'export const value = 1;\n',
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

    const adapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl,
    });

    const context: ProviderStepContext = {
      modelId: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: 'You are a coding assistant' },
        { role: 'user', content: 'Create src/example.ts.' },
      ],
      availableTools: [
        {
          name: 'edit',
          description: 'Edit a file',
          executionPolicy: getToolExecutionPolicy('edit'),
          inputSchema: providerEditToolInputSchema,
        },
      ],
    };

    const result = await adapter.runStep(context);

    expect(result.type).toBe('tool-call');
    if (result.type !== 'tool-call') {
      throw new Error('Expected tool-call result');
    }

    expect(result.toolName).toBe('edit');
    expect(result.toolCallId).toBe('tool-edit-create-1');
    expect(result.args).toEqual({
      path: 'src/example.ts',
      oldText: '',
      newText: 'export const value = 1;\n',
    });
  });

  it('should accept legacy write tool calls returned by DeepSeek', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: 'I can write the file now.',
              tool_calls: [
                {
                  id: 'tool-write-1',
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

    const adapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl,
    });

    const context: ProviderStepContext = {
      modelId: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: 'You are a coding assistant' },
        { role: 'user', content: 'Create src/example.ts.' },
      ],
      availableTools: [
        {
          name: 'edit',
          description: 'Edit a file',
          executionPolicy: getToolExecutionPolicy('edit'),
          inputSchema: providerEditToolInputSchema,
        },
      ],
    };

    const result = await adapter.runStep(context);

    expect(result.type).toBe('tool-call');
    if (result.type !== 'tool-call') {
      throw new Error('Expected tool-call result');
    }

    expect(result.toolName).toBe('edit');
    expect(result.toolCallId).toBe('tool-write-1');
    expect(result.args).toEqual({
      path: 'src/example.ts',
      oldText: '',
      newText: 'export const value = 1;\n',
    });
  });

  it('should accept start-only edit tool calls returned by DeepSeek', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: 'I can update the lower section now.',
              tool_calls: [
                {
                  id: 'tool-edit-start-1',
                  type: 'function',
                  function: {
                    name: 'edit',
                    arguments: JSON.stringify({
                      path: 'src/example.ts',
                      oldText: 'alpha',
                      newText: 'beta',
                      startLine: 20,
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

    const adapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl,
    });

    const context: ProviderStepContext = {
      modelId: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: 'You are a coding assistant' },
        { role: 'user', content: 'Update the lower section from line 20 onward.' },
      ],
      availableTools: [
        {
          name: 'edit',
          description: 'Edit a file',
          executionPolicy: getToolExecutionPolicy('edit'),
          inputSchema: providerEditToolInputSchema,
        },
      ],
    };

    const result = await adapter.runStep(context);

    expect(result.type).toBe('tool-call');
    if (result.type !== 'tool-call') {
      throw new Error('Expected tool-call result');
    }

    expect(result.toolName).toBe('edit');
    expect(result.toolCallId).toBe('tool-edit-start-1');
    expect(result.args).toEqual({
      path: 'src/example.ts',
      oldText: 'alpha',
      newText: 'beta',
      startLine: 20,
    });
  });

  it('should preserve multiple DeepSeek tool calls within one assistant turn', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'I need both file discovery and content search.',
                reasoning_content: 'Two tools are needed before I can answer.',
                tool_calls: [
                  {
                    id: 'tool-1',
                    type: 'function',
                    function: {
                      name: 'glob',
                      arguments: JSON.stringify({ pattern: 'src/**/*.ts' }),
                    },
                  },
                  {
                    id: 'tool-2',
                    type: 'function',
                    function: {
                      name: 'grep',
                      arguments: JSON.stringify({ pattern: 'task', include: '*.ts' }),
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
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'Done.',
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

    const adapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl,
    });

    const initialContext: ProviderStepContext = {
      modelId: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: 'You are a coding assistant' },
        { role: 'user', content: 'Inspect repository files and usages.' },
      ],
      availableTools: [
        {
          name: 'glob',
          description: 'Find files by glob pattern',
          executionPolicy: getToolExecutionPolicy('glob'),
          inputSchema: providerGlobToolInputSchema,
        },
        {
          name: 'grep',
          description: 'Search file contents',
          executionPolicy: getToolExecutionPolicy('grep'),
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
    };

    const firstStep = await adapter.runStep(initialContext);
    expect(firstStep.type).toBe('tool-calls');
    if (firstStep.type !== 'tool-calls') {
      throw new Error('Expected grouped tool-calls result');
    }

    expect(firstStep.toolCalls).toHaveLength(2);
    expect(firstStep.reasoningContent).toBe('Two tools are needed before I can answer.');

    const followUpContext: ProviderStepContext = {
      modelId: 'deepseek-v4-pro',
      messages: [
        ...initialContext.messages,
        {
          role: 'assistant',
          content: firstStep.rationale ?? 'Requesting multiple tools',
          toolCalls: firstStep.toolCalls,
          reasoningContent: firstStep.reasoningContent,
        },
        {
          role: 'tool',
          content: JSON.stringify({ status: 'succeeded', summary: 'Found files', output: ['src/main.ts'] }),
          toolCallId: firstStep.toolCalls[0]?.toolCallId,
          toolName: firstStep.toolCalls[0]?.toolName,
        },
        {
          role: 'tool',
          content: JSON.stringify({ status: 'succeeded', summary: 'Found matches', output: ['src/agent/task-runner.ts'] }),
          toolCallId: firstStep.toolCalls[1]?.toolCallId,
          toolName: firstStep.toolCalls[1]?.toolName,
        },
      ],
      availableTools: initialContext.availableTools,
    };

    await adapter.runStep(followUpContext);

    const secondRequestPayload = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as {
      messages?: Array<{ role?: string; reasoning_content?: string; tool_calls?: Array<{ id?: string }> }>;
    };
    const assistantMessage = secondRequestPayload.messages?.find((message) => message.role === 'assistant');

    expect(assistantMessage?.reasoning_content).toBe('Two tools are needed before I can answer.');
    expect(assistantMessage?.tool_calls).toHaveLength(2);
    expect(assistantMessage?.tool_calls?.map((toolCall) => toolCall.id)).toEqual(['tool-1', 'tool-2']);
  });

  it('should accept read tool calls returned by DeepSeek', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'tool-read-1',
                  type: 'function',
                  function: {
                    name: 'read',
                    arguments: JSON.stringify({ path: 'src/agent/task-runner.ts' }),
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

    const adapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl,
    });

    const result = await adapter.runStep({
      modelId: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Read the task runner.' }],
      availableTools: [
        {
          name: 'read',
          description: 'Read a file',
          executionPolicy: getToolExecutionPolicy('read'),
          inputSchema: providerReadToolInputSchema,
        },
      ],
    });

    expect(result).toEqual({
      type: 'tool-call',
      toolCallId: 'tool-read-1',
      toolName: 'read',
      args: { path: 'src/agent/task-runner.ts' },
      rationale: undefined,
      reasoningContent: undefined,
    });
  });

  it('should accept start-only read tool calls returned by DeepSeek', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'tool-read-start-1',
                  type: 'function',
                  function: {
                    name: 'read',
                    arguments: JSON.stringify({ path: 'src/agent/task-runner.ts', startLine: 200 }),
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

    const adapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl,
    });

    const result = await adapter.runStep({
      modelId: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Read the rest of the task runner from line 200.' }],
      availableTools: [
        {
          name: 'read',
          description: 'Read a file',
          executionPolicy: getToolExecutionPolicy('read'),
          inputSchema: providerReadToolInputSchema,
        },
      ],
    });

    expect(result).toEqual({
      type: 'tool-call',
      toolCallId: 'tool-read-start-1',
      toolName: 'read',
      args: { path: 'src/agent/task-runner.ts', startLine: 200 },
      rationale: undefined,
      reasoningContent: undefined,
    });
  });
});