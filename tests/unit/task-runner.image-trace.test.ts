import { describe, expect, it } from 'vitest';
import { summarizeTraceMessages } from '../../src/agent/task-runner';
import type { ProviderMessage } from '../../src/providers/provider-adapter';

describe('summarizeTraceMessages image observability', () => {
  it('reports imageCount and base64-free fingerprints for user image parts', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const messages: ProviderMessage[] = [
      { role: 'system', content: 'system prompt' },
      {
        role: 'user',
        content: 'read the uploaded paper',
        imageParts: [
          {
            dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
            mimeType: 'image/png',
            sourcePath: 'materials/paper-01.png',
          },
        ],
      },
    ];

    const trace = summarizeTraceMessages(messages);

    expect(trace[0]?.imageCount).toBe(0);
    expect(trace[0]?.images).toBeUndefined();
    expect(trace[1]?.imageCount).toBe(1);
    expect(trace[1]?.images?.[0]).toMatchObject({ sourcePath: 'materials/paper-01.png', mimeType: 'image/png', bytes: bytes.byteLength });
    expect(trace[1]?.images?.[0]?.sha256Prefix).toMatch(/^[0-9a-f]{8}$/);
  });

  it('ignores image parts on non-user messages', () => {
    const messages: ProviderMessage[] = [
      {
        role: 'tool',
        content: 'tool output',
        toolCallId: 'call-1',
        toolName: 'read',
        imageParts: [{ dataUrl: 'data:image/png;base64,AAAA' }],
      },
    ];

    const trace = summarizeTraceMessages(messages);

    expect(trace[0]?.imageCount).toBe(0);
    expect(trace[0]?.toolCallId).toBe('call-1');
  });
});
