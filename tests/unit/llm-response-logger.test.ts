import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLlmResponseLogger } from '../../src/providers/llm-response-logger';

describe('llm response logger', () => {
  it('preserves nested error causes in logged details', () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-llm-log-'));
    const logger = createLlmResponseLogger({ baseDir: logDir });

    const connectTimeoutError = new Error('Connect Timeout Error');
    Object.assign(connectTimeoutError, { code: 'UND_ERR_CONNECT_TIMEOUT' });

    const fetchError = new TypeError('fetch failed');
    Object.defineProperty(fetchError, 'cause', {
      value: connectTimeoutError,
      configurable: true,
    });

    logger.log({
      providerId: 'deepseek',
      category: 'network-error',
      message: 'DeepSeek network request failed',
      details: {
        attempt: 2,
        error: fetchError,
      },
    });

    const [logFile] = fs.readdirSync(logDir);
    expect(logFile).toBeTruthy();

    const logContent = JSON.parse(fs.readFileSync(path.join(logDir, logFile ?? ''), 'utf8')) as {
      details?: {
        error?: {
          message?: string;
          cause?: {
            message?: string;
            code?: string;
          };
        };
      };
    };

    expect(logContent.details?.error?.message).toBe('fetch failed');
    expect(logContent.details?.error?.cause).toEqual(expect.objectContaining({
      message: 'Connect Timeout Error',
      code: 'UND_ERR_CONNECT_TIMEOUT',
    }));
  });
});