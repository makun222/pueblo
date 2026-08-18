import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { readInstantNotes, saveInstantNote, resolveInstantNotesStoragePath } from '../../src/desktop/shared/instant-notes';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('instant notes service', () => {
  it('stores session metadata and turn ids with each note', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instant-notes-'));
    tempDirs.push(tempDir);
    const storagePath = resolveInstantNotesStoragePath(tempDir);
    const runtimeStatus = {
      activeSessionId: 'session-123',
      agentProfileId: 'agent-1',
      agentProfileName: 'Planner',
      modelId: 'model-1',
      modelName: 'GPT-4o',
      workspace: '/workspace/project',
    } as any;
    const session = {
      id: 'session-123',
      title: 'Demo Session',
      messageHistory: [
        { turnId: 'session-123-turn-1' },
        { turnId: 'session-123-turn-2' },
        { turnId: 'session-123-turn-2' },
      ],
    } as any;

    const note = await saveInstantNote(storagePath, { content: '记住这个想法' }, runtimeStatus, session);
    const notes = await readInstantNotes(storagePath);

    expect(note.content).toBe('记住这个想法');
    expect(note.sessionId).toBe('session-123');
    expect(note.sessionTitle).toBe('Demo Session');
    expect(note.turnIds).toEqual(['session-123-turn-1', 'session-123-turn-2']);
    expect(notes).toHaveLength(1);
    expect(notes[0].agentProfileName).toBe('Planner');
  });

  it('rejects notes longer than 2000 characters', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instant-notes-'));
    tempDirs.push(tempDir);
    const storagePath = resolveInstantNotesStoragePath(tempDir);

    await expect(
      saveInstantNote(storagePath, { content: 'x'.repeat(2001) }, { activeSessionId: null } as any, null),
    ).rejects.toThrow(/超过 2000/);
  });
});
