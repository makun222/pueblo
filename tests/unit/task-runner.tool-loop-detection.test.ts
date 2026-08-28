import { describe, expect, it } from 'vitest';
import type { ProviderToolCall } from '../../src/providers/provider-adapter';
import {
  createIntentFingerprint,
  createToolLoopFingerprint,
} from '../../src/agent/task-runner';

function makeReadCall(callId: string, path: string, startLine?: number, endLine?: number): ProviderToolCall {
  const args: Record<string, unknown> = { path };
  if (startLine !== undefined) args.startLine = startLine;
  if (endLine !== undefined) args.endLine = endLine;
  return {
    toolCallId: callId,
    toolName: 'read',
    args: args as any,
  };
}

function makeGrepCall(callId: string, pattern: string, include?: string): ProviderToolCall {
  const args: Record<string, unknown> = { pattern };
  if (include !== undefined) args.include = include;
  return {
    toolCallId: callId,
    toolName: 'grep',
    args: args as any,
  };
}

function makeExecCall(callId: string, command: string): ProviderToolCall {
  return {
    toolCallId: callId,
    toolName: 'exec',
    args: { command } as any,
  };
}

describe('tool loop fingerprint detection', () => {
  describe('createToolLoopFingerprint (strict)', () => {
    it('produces different fingerprints when args differ', () => {
      const calls1 = [makeReadCall('call-1', 'foo.txt', 1, 10)];
      const calls2 = [makeReadCall('call-2', 'foo.txt', 1, 20)];

      const fp1 = createToolLoopFingerprint(calls1, []);
      const fp2 = createToolLoopFingerprint(calls2, []);

      expect(fp1).not.toBe(fp2);
    });

    it('produces identical fingerprints when args match', () => {
      const calls1 = [makeReadCall('call-1', 'foo.txt', 1, 10)];
      const calls2 = [makeReadCall('call-2', 'foo.txt', 1, 10)];

      const fp1 = createToolLoopFingerprint(calls1, []);
      const fp2 = createToolLoopFingerprint(calls2, []);

      expect(fp1).toBe(fp2);
    });
  });

  describe('createIntentFingerprint (normalized intent)', () => {
    it('treats reads of the same file at different line ranges as the same intent', () => {
      const calls1 = [makeReadCall('call-1', 'src/foo.ts', 1, 30)];
      const calls2 = [makeReadCall('call-2', 'src/foo.ts', 31, 60)];
      const calls3 = [makeReadCall('call-3', 'src/foo.ts', 1, 82)];

      const fp1 = createIntentFingerprint(calls1);
      const fp2 = createIntentFingerprint(calls2);
      const fp3 = createIntentFingerprint(calls3);

      expect(fp1).toBe(fp2);
      expect(fp1).toBe(fp3);
    });

    it('treats reads of different files as different intents', () => {
      const calls1 = [makeReadCall('call-1', 'src/foo.ts')];
      const calls2 = [makeReadCall('call-2', 'src/bar.ts')];

      const fp1 = createIntentFingerprint(calls1);
      const fp2 = createIntentFingerprint(calls2);

      expect(fp1).not.toBe(fp2);
    });

    it('normalizes path separators so Windows and POSIX paths match', () => {
      const calls1 = [makeReadCall('call-1', 'src\\foo.ts')];
      const calls2 = [makeReadCall('call-2', 'src/foo.ts')];

      const fp1 = createIntentFingerprint(calls1);
      const fp2 = createIntentFingerprint(calls2);

      expect(fp1).toBe(fp2);
    });

    it('treats grep calls with the same pattern+include as the same intent', () => {
      const calls1 = [makeGrepCall('call-1', 'TODO', 'src/**/*.ts')];
      const calls2 = [makeGrepCall('call-2', 'TODO', 'src/**/*.ts')];

      const fp1 = createIntentFingerprint(calls1);
      const fp2 = createIntentFingerprint(calls2);

      expect(fp1).toBe(fp2);
    });

    it('treats grep calls with different includes as different intents', () => {
      const calls1 = [makeGrepCall('call-1', 'TODO', 'src/**/*.ts')];
      const calls2 = [makeGrepCall('call-2', 'TODO', 'tests/**/*.ts')];

      const fp1 = createIntentFingerprint(calls1);
      const fp2 = createIntentFingerprint(calls2);

      expect(fp1).not.toBe(fp2);
    });

    it('uses only the first command token for exec intent', () => {
      const calls1 = [makeExecCall('call-1', 'npm test -- --grep pattern')];
      const calls2 = [makeExecCall('call-2', 'npm run build')];

      const fp1 = createIntentFingerprint(calls1);
      const fp2 = createIntentFingerprint(calls2);

      expect(fp1).toBe(fp2);
    });

    it('distinguishes exec commands with different executables', () => {
      const calls1 = [makeExecCall('call-1', 'git status')];
      const calls2 = [makeExecCall('call-2', 'npm test')];

      const fp1 = createIntentFingerprint(calls1);
      const fp2 = createIntentFingerprint(calls2);

      expect(fp1).not.toBe(fp2);
    });

    it('distinguishes different tool names even with same key', () => {
      const readCall: ProviderToolCall = {
        toolCallId: 'call-1',
        toolName: 'read',
        args: { path: 'foo.ts' } as any,
      };
      const editCall: ProviderToolCall = {
        toolCallId: 'call-2',
        toolName: 'edit',
        args: { path: 'foo.ts', oldText: '', newText: '' } as any,
      };

      const fp1 = createIntentFingerprint([readCall]);
      const fp2 = createIntentFingerprint([editCall]);

      expect(fp1).not.toBe(fp2);
    });
  });

  describe('intent vs strict fingerprint interaction', () => {
    it('intent matches but strict differs for same-file different-range reads', () => {
      const calls1 = [makeReadCall('call-1', 'src/foo.ts', 1, 30)];
      const calls2 = [makeReadCall('call-2', 'src/foo.ts', 31, 60)];

      const strict1 = createToolLoopFingerprint(calls1, []);
      const strict2 = createToolLoopFingerprint(calls2, []);
      const intent1 = createIntentFingerprint(calls1);
      const intent2 = createIntentFingerprint(calls2);

      expect(strict1).not.toBe(strict2);
      expect(intent1).toBe(intent2);
    });
  });
});
