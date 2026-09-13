import { describe, expect, it, vi } from 'vitest';
import { DeepSeekAdapter } from '../../src/providers/deepseek-adapter';
import { createDeepSeekProfile } from '../../src/providers/deepseek-profile';
import { type ProviderStepContext } from '../../src/providers/provider-adapter';
import { ProviderError } from '../../src/providers/provider-errors';

function createAdapter(fetchImpl: ReturnType<typeof vi.fn>): DeepSeekAdapter {
  return new DeepSeekAdapter({
    apiKey: 'deepseek-key',
    baseUrl: 'https://api.deepseek.com',
    fetchImpl,
  });
}

function createOkFetch() {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: 'ok', role: 'assistant' } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
}

describe('DeepSeek vision model registration', () => {
  it('should register the vision model with supportsVision flag', () => {
    const profile = createDeepSeekProfile('configured');

    expect(profile.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'deepseek-v4-flash-vision-exp', supportsVision: true }),
        // 上游实测 deepseek-v4-flash 支持图片输入（见 image-capability-probe 探针结果），不再标记为不支持。
        expect.objectContaining({ id: 'deepseek-v4-flash', supportsVision: true }),
      ]),
    );
  });
});

describe('DeepSeek vision request serialization', () => {
  it('should send user image parts as OpenAI-style content parts when model supports vision', async () => {
    const fetchImpl = createOkFetch();
    const adapter = createAdapter(fetchImpl);
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    await adapter.runStep({
      modelId: 'deepseek-v4-flash-vision-exp',
      supportsVision: true,
      messages: [
        {
          role: 'user',
          content: 'What is in this image?',
          imageParts: [{ dataUrl, mimeType: 'image/png' }],
        },
      ],
      availableTools: [],
    } satisfies ProviderStepContext);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    const payload = JSON.parse(init.body) as {
      messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
    };
    expect(payload.messages[0]!.role).toBe('user');
    expect(payload.messages[0]!.content).toEqual([
      { type: 'text', text: 'What is in this image?' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ]);
  });

  it('should keep plain text user messages as a content string (no image parts regression)', async () => {
    const fetchImpl = createOkFetch();
    const adapter = createAdapter(fetchImpl);

    await adapter.runStep({
      modelId: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      availableTools: [],
    } satisfies ProviderStepContext);

    const [, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    const payload = JSON.parse(init.body) as { messages: Array<{ role: string; content: unknown }> };
    expect(payload.messages[0]!.content).toBe('Hello');
  });

  it('should reject image messages when the model does not support vision', async () => {
    const fetchImpl = createOkFetch();
    const adapter = createAdapter(fetchImpl);

    const promise = adapter.runStep({
      modelId: 'deepseek-v4-pro',
      // supportsVision omitted -> treated as unsupported (闸门只认 context.supportsVision，与模型 id 无关)
      messages: [
        {
          role: 'user',
          content: 'Look',
          imageParts: [{ dataUrl: 'data:image/png;base64,AAAA' }],
        },
      ],
      availableTools: [],
    } satisfies ProviderStepContext);

    await expect(promise).rejects.toBeInstanceOf(ProviderError);
    await expect(promise).rejects.toThrow(/does not support image input/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
