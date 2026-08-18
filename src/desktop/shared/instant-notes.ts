import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { DesktopRuntimeStatus } from './ipc-contract';
import type { Session } from '../../shared/schema';

export const MAX_INSTANT_NOTE_LENGTH = 2000;

export interface InstantNoteContext {
  readonly sessionId: string | null;
  readonly sessionTitle: string | null;
  readonly agentProfileId: string | null;
  readonly agentProfileName: string | null;
  readonly modelId: string | null;
  readonly modelName: string | null;
  readonly workspace: string | null;
  readonly turnIds: readonly string[];
}

export interface InstantNoteRecord extends InstantNoteContext {
  readonly id: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InstantNoteDraft extends Partial<InstantNoteContext> {
  readonly content: string;
  readonly id?: string;
}

export function resolveInstantNotesStoragePath(baseDir?: string): string {
  const storageDirectory = baseDir ?? process.env.PUEBLO_INSTANT_NOTES_DIR ?? path.join(process.cwd(), '.pueblo');
  return path.join(storageDirectory, 'instant-notes.json');
}

export function normalizeInstantNoteContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('即时贴内容不能为空。');
  }
  if (trimmed.length > MAX_INSTANT_NOTE_LENGTH) {
    throw new Error(`即时贴内容不能超过 ${MAX_INSTANT_NOTE_LENGTH} 字符。`);
  }
  return trimmed;
}

export function buildInstantNoteRecord(
  content: string,
  runtimeStatus: Pick<DesktopRuntimeStatus, 'activeSessionId' | 'agentProfileId' | 'agentProfileName' | 'modelId' | 'modelName' | 'workspace'>,
  session: Session | null | undefined,
  overrides?: Partial<InstantNoteRecord>,
): InstantNoteRecord {
  const normalizedContent = normalizeInstantNoteContent(content);
  const now = new Date().toISOString();
  const sessionMessages = session?.messageHistory ?? [];
  const turnIds: string[] = Array.from(new Set(
    sessionMessages
      .map((message) => message.turnId)
      .filter((turnId): turnId is string => typeof turnId === 'string' && turnId.length > 0),
  )).slice(-20);

  const note: InstantNoteRecord = {
    id: overrides?.id ?? randomUUID(),
    content: normalizedContent,
    createdAt: overrides?.createdAt ?? now,
    updatedAt: overrides?.updatedAt ?? now,
    sessionId: overrides?.sessionId ?? runtimeStatus.activeSessionId ?? session?.id ?? null,
    sessionTitle: overrides?.sessionTitle ?? session?.title ?? null,
    agentProfileId: overrides?.agentProfileId ?? runtimeStatus.agentProfileId ?? null,
    agentProfileName: overrides?.agentProfileName ?? runtimeStatus.agentProfileName ?? null,
    modelId: overrides?.modelId ?? runtimeStatus.modelId ?? null,
    modelName: overrides?.modelName ?? runtimeStatus.modelName ?? null,
    workspace: overrides?.workspace ?? runtimeStatus.workspace ?? null,
    turnIds,
  };

  return note;
}

export async function readInstantNotes(storagePath: string): Promise<InstantNoteRecord[]> {
  try {
    const raw = await fs.readFile(storagePath, 'utf8');
    if (!raw.trim()) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => normalizeStoredInstantNote(item))
      .filter((item): item is InstantNoteRecord => item !== null)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function writeInstantNotes(storagePath: string, notes: InstantNoteRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(storagePath), { recursive: true });
  await fs.writeFile(storagePath, JSON.stringify(notes, null, 2), 'utf8');
}

export async function saveInstantNote(storagePath: string, draft: InstantNoteDraft, runtimeStatus: Pick<DesktopRuntimeStatus, 'activeSessionId' | 'agentProfileId' | 'agentProfileName' | 'modelId' | 'modelName' | 'workspace'>, session: Session | null | undefined): Promise<InstantNoteRecord> {
  const existingNotes = await readInstantNotes(storagePath);
  const normalizedDraft = {
    ...draft,
    content: normalizeInstantNoteContent(draft.content),
  };

  const nextNote = buildInstantNoteRecord(normalizedDraft.content, runtimeStatus, session, {
    id: draft.id ?? undefined,
    createdAt: existingNotes.find((note) => note.id === draft.id)?.createdAt,
    updatedAt: new Date().toISOString(),
    sessionId: draft.sessionId ?? runtimeStatus.activeSessionId ?? session?.id ?? null,
    sessionTitle: draft.sessionTitle ?? session?.title ?? null,
    agentProfileId: draft.agentProfileId ?? runtimeStatus.agentProfileId ?? null,
    agentProfileName: draft.agentProfileName ?? runtimeStatus.agentProfileName ?? null,
    modelId: draft.modelId ?? runtimeStatus.modelId ?? null,
    modelName: draft.modelName ?? runtimeStatus.modelName ?? null,
    workspace: draft.workspace ?? runtimeStatus.workspace ?? null,
    turnIds: draft.turnIds ?? [],
  });

  const nextNotes = draft.id
    ? existingNotes.map((note) => note.id === draft.id ? nextNote : note)
    : [nextNote, ...existingNotes];

  await writeInstantNotes(storagePath, nextNotes);
  return nextNote;
}

export async function deleteInstantNote(storagePath: string, noteId: string): Promise<InstantNoteRecord[]> {
  const notes = await readInstantNotes(storagePath);
  const nextNotes = notes.filter((note) => note.id !== noteId);
  await writeInstantNotes(storagePath, nextNotes);
  return nextNotes;
}

function normalizeStoredInstantNote(value: unknown): InstantNoteRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<InstantNoteRecord>;
  if (!record.id || typeof record.content !== 'string') {
    return null;
  }

  try {
    return {
      id: record.id,
      content: normalizeInstantNoteContent(record.content),
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
      sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
      sessionTitle: typeof record.sessionTitle === 'string' ? record.sessionTitle : null,
      agentProfileId: typeof record.agentProfileId === 'string' ? record.agentProfileId : null,
      agentProfileName: typeof record.agentProfileName === 'string' ? record.agentProfileName : null,
      modelId: typeof record.modelId === 'string' ? record.modelId : null,
      modelName: typeof record.modelName === 'string' ? record.modelName : null,
      workspace: typeof record.workspace === 'string' ? record.workspace : null,
      turnIds: Array.isArray(record.turnIds) ? record.turnIds.filter((turnId): turnId is string => typeof turnId === 'string') : [],
    };
  } catch {
    return null;
  }
}
