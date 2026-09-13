import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProviderMessages } from '../../src/agent/task-message-builder';
import { createTaskContext } from '../../src/agent/task-context';
import { createEmptyPuebloProfile } from '../../src/agent/pueblo-profile';
import type { MaterialImageRef } from '../../src/agent/material-injector';
import { createTestAppConfig } from '../helpers/test-config';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function writePng(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-material-builder-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]));
  return filePath;
}

function createContext(input: { materialImages?: MaterialImageRef[]; materialIndexText?: string | null }) {
  return createTaskContext({
    config: createTestAppConfig(),
    puebloProfile: createEmptyPuebloProfile(null),
    contextCount: {
      estimatedTokens: 0,
      contextWindowLimit: null,
      utilizationRatio: null,
      messageCount: 0,
      selectedPromptCount: 0,
      derivedMemoryCount: 0,
    },
    materialImages: input.materialImages,
    materialIndexText: input.materialIndexText,
  });
}

describe('buildProviderMessages material injection', () => {
  it('attaches scanned material images to the user message as image parts', () => {
    const filePath = writePng('paper-01.png');
    const material: MaterialImageRef = {
      absolutePath: filePath,
      relativePath: 'materials/paper-01.png',
      fileName: 'paper-01.png',
      mimeType: 'image/png',
      sizeBytes: 16,
      mtimeMs: 0,
    };

    const context = createContext({ materialImages: [material], materialIndexText: 'About the `materials/` directory' });
    const messages = buildProviderMessages(context, 'Solve the exam paper');

    const userMessage = messages.at(-1);
    expect(userMessage?.role).toBe('user');
    expect(userMessage?.imageParts).toHaveLength(1);
    expect(userMessage?.imageParts?.[0]?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(userMessage?.imageParts?.[0]?.mimeType).toBe('image/png');
  });

  it('includes the materials index section when present', () => {
    const context = createContext({ materialIndexText: 'About the `materials/` directory (auto-scanned)' });
    const messages = buildProviderMessages(context, 'Solve the exam paper');

    const systemContents = messages.filter((message) => message.role === 'system').map((message) => message.content);
    expect(systemContents.some((content) => content.includes('About the `materials/` directory'))).toBe(true);
  });

  it('omits image parts when no material images are selected', () => {
    const context = createContext({ materialImages: [], materialIndexText: null });
    const messages = buildProviderMessages(context, 'Solve the exam paper');

    expect(messages.at(-1)?.imageParts).toBeUndefined();
  });

  it('skips a material image that disappeared between scan and send', () => {
    const filePath = writePng('paper-01.png');
    const material: MaterialImageRef = {
      absolutePath: filePath,
      relativePath: 'materials/paper-01.png',
      fileName: 'paper-01.png',
      mimeType: 'image/png',
      sizeBytes: 16,
      mtimeMs: 0,
    };
    fs.rmSync(filePath);

    const context = createContext({ materialImages: [material] });
    const messages = buildProviderMessages(context, 'Solve the exam paper');

    expect(messages.at(-1)?.imageParts).toBeUndefined();
  });
});
