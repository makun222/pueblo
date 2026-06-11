/**
 * Snapshot Engine — Time Machine for file edits
 *
 * Core mechanism for the auto-save mode:
 *  1. Create a snapshot before any direct write
 *  2. Detect external modifications (conflict detection)
 *  3. Restore the most recent snapshot on undo
 *  4. Prune old snapshots (keep last N + TTL-based expiry)
 *
 * Snapshot storage layout:
 *  .pueblo/file-snapshots/{relative-path-encoded}/
 *    ├── snapshot-{timestamp}.txt       # Full file content at snapshot time
 *    └── ...
 *
 * Design decisions (locked):
 *  - Per-file max 50 snapshots (configurable)
 *  - 7-day TTL for snapshots older than the count cap
 *  - Phase 1: restore only most recent; Phase 2: version picker
 *  - Conflict detection: SHA-256 hash comparison
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SnapshotEntry {
  /** Absolute path to the snapshot file */
  readonly filePath: string;
  /** Creation timestamp (ISO-8601) */
  readonly timestamp: string;
  /** Milliseconds since epoch */
  readonly epochMs: number;
  /** SHA-256 hash of snapshot content */
  readonly hash: string;
}

export interface SnapshotOptions {
  /** Maximum snapshots per file (default: 50) */
  readonly maxSnapshotsPerFile?: number;
  /** TTL in days for snapshots beyond the count cap (default: 7) */
  readonly ttlDays?: number;
}

export interface ConflictCheckResult {
  /** Whether a conflict was detected */
  readonly hasConflict: boolean;
  /** Hash of the snapshot used for comparison */
  readonly snapshotHash: string;
  /** Hash of the current file on disk */
  readonly currentHash: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SNAPSHOTS_DIR = 'file-snapshots';
const DEFAULT_MAX_SNAPSHOTS = 50;
const DEFAULT_TTL_DAYS = 7;
const SNAPSHOT_PREFIX = 'snapshot-';
const SNAPSHOT_EXT = '.txt';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Encode a relative or absolute file path into a filesystem-safe directory name.
 * Replaces path separators and colons with underscores.
 *
 * Example: "src/tools/edit-tool.ts" → "src_tools_edit-tool.ts"
 */
function encodeFilePath(filePath: string): string {
  return filePath
    .replace(/[:\\]/g, '_')
    .replace(/\//g, '_')
    .replace(/^_+/, '');
}

function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[:.]/g, '-');
}

function parseEpochFromFilename(filename: string): number | null {
  // Expected: snapshot-2024-01-01T00-00-00-000Z.txt
  if (!filename.startsWith(SNAPSHOT_PREFIX) || !filename.endsWith(SNAPSHOT_EXT)) {
    return null;
  }
  const inner = filename.slice(
    SNAPSHOT_PREFIX.length,
    filename.length - SNAPSHOT_EXT.length,
  );
  // Convert back to ISO format
  const iso = inner.replace(/-/g, ':').replace(/T(\d{2}):(\d{2}):(\d{2}):(\d{3})Z/, 'T$1:$2:$3.$4Z');
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export class SnapshotEngine {
  private readonly workspaceRoot: string;
  private readonly maxSnapshots: number;
  private readonly ttlMs: number;

  constructor(workspaceRoot: string, options: SnapshotOptions = {}) {
    this.workspaceRoot = workspaceRoot;
    this.maxSnapshots = options.maxSnapshotsPerFile ?? DEFAULT_MAX_SNAPSHOTS;
    this.ttlMs = (options.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000;
  }

  /**
   * Resolve the snapshot directory for a given file path.
   */
  private snapshotDir(resolvedFilePath: string): string {
    const relative = path.relative(this.workspaceRoot, resolvedFilePath);
    const encoded = encodeFilePath(relative);
    return path.join(this.workspaceRoot, '.pueblo', SNAPSHOTS_DIR, encoded);
  }

  /**
   * Create a snapshot of the given file.
   *
   * Reads the current file content, writes a timestamped snapshot,
   * and triggers pruning.
   *
   * @returns The created SnapshotEntry
   * @throws If the file does not exist or cannot be read
   */
  async createSnapshot(filePath: string): Promise<SnapshotEntry> {
    const resolvedPath = path.resolve(this.workspaceRoot, filePath);
    const content = await fs.readFile(resolvedPath, 'utf-8');
    const hash = sha256(content);
    const epochMs = Date.now();
    const ts = formatTimestamp(epochMs);
    const snapshotDir = this.snapshotDir(resolvedPath);

    await fs.mkdir(snapshotDir, { recursive: true });

    const snapshotFile = path.join(snapshotDir, `${SNAPSHOT_PREFIX}${ts}${SNAPSHOT_EXT}`);
    await fs.writeFile(snapshotFile, content, 'utf-8');

    // Asynchronously prune old snapshots (don't block the write)
    this.pruneSnapshots(filePath).catch(() => {
      // Best-effort; swallow pruning errors to avoid perturbing the edit flow
    });

    return {
      filePath: snapshotFile,
      timestamp: new Date(epochMs).toISOString(),
      epochMs,
      hash,
    };
  }

  /**
   * Create a "null" snapshot for new files.
   *
   * Records that the file did not exist at the time of creation, so undo
   * can delete it. The null snapshot has empty content and a special hash.
   */
  async createNullSnapshot(filePath: string): Promise<SnapshotEntry> {
    const resolvedPath = path.resolve(this.workspaceRoot, filePath);
    const epochMs = Date.now();
    const ts = formatTimestamp(epochMs);
    const snapshotDir = this.snapshotDir(resolvedPath);
    const hash = 'null-file-did-not-exist';

    await fs.mkdir(snapshotDir, { recursive: true });

    const snapshotFile = path.join(snapshotDir, `${SNAPSHOT_PREFIX}${ts}.null${SNAPSHOT_EXT}`);
    await fs.writeFile(snapshotFile, '__NULL_SNAPSHOT__', 'utf-8');

    return {
      filePath: snapshotFile,
      timestamp: new Date(epochMs).toISOString(),
      epochMs,
      hash,
    };
  }

  /**
   * Check for external modifications since the most recent snapshot.
   *
   * Compares the current on-disk hash against the stored snapshot hash.
   * If there's no prior snapshot, returns `{ hasConflict: false }`.
   */
  async checkConflict(filePath: string): Promise<ConflictCheckResult> {
    const resolvedPath = path.resolve(this.workspaceRoot, filePath);
    const latest = await this.getMostRecentSnapshot(filePath);

    let currentContent: string;
    try {
      currentContent = await fs.readFile(resolvedPath, 'utf-8');
    } catch {
      // File doesn't exist — can't have a conflict
      return { hasConflict: false, snapshotHash: '', currentHash: '' };
    }

    const currentHash = sha256(currentContent);

    if (!latest) {
      return { hasConflict: false, snapshotHash: '', currentHash };
    }

    const snapshotContent = await fs.readFile(latest.filePath, 'utf-8');
    const snapshotHash = latest.hash === 'null-file-did-not-exist'
      ? sha256('__NULL_SNAPSHOT__')
      : sha256(snapshotContent);

    return {
      hasConflict: snapshotHash !== currentHash,
      snapshotHash: latest.hash,
      currentHash,
    };
  }

  /**
   * List all snapshots for a file, ordered most recent first.
   */
  async listSnapshots(filePath: string): Promise<SnapshotEntry[]> {
    const resolvedPath = path.resolve(this.workspaceRoot, filePath);
    const snapshotDir = this.snapshotDir(resolvedPath);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(snapshotDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const snapshots: SnapshotEntry[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const epochMs = parseEpochFromFilename(entry.name);
      if (epochMs === null) continue;

      const filePath = path.join(snapshotDir, entry.name);
      const content = await fs.readFile(filePath, 'utf-8');
      const hash = entry.name.endsWith('.null.txt')
        ? 'null-file-did-not-exist'
        : sha256(content);

      snapshots.push({
        filePath,
        timestamp: new Date(epochMs).toISOString(),
        epochMs,
        hash,
      });
    }

    snapshots.sort((a, b) => b.epochMs - a.epochMs);
    return snapshots;
  }

  /**
   * Get the most recent snapshot for a file, or null if none exists.
   */
  async getMostRecentSnapshot(filePath: string): Promise<SnapshotEntry | null> {
    const snapshots = await this.listSnapshots(filePath);
    return snapshots.length > 0 ? snapshots[0] : null;
  }

  /**
   * Restore a file from its most recent snapshot (Phase 1).
   *
   * If the snapshot is a null snapshot (file was created), deletes the file.
   * Otherwise, overwrites the current file with the snapshot content.
   *
   * @returns The restored SnapshotEntry
   * @throws If no snapshot exists
   */
  async restoreFromSnapshot(filePath: string): Promise<SnapshotEntry> {
    const snapshot = await this.getMostRecentSnapshot(filePath);
    if (!snapshot) {
      throw new Error(`No snapshot found for ${filePath}`);
    }

    const resolvedPath = path.resolve(this.workspaceRoot, filePath);

    if (snapshot.hash === 'null-file-did-not-exist') {
      // File was created by the edit — delete it
      try {
        await fs.unlink(resolvedPath);
      } catch {
        // File may already be gone; that's fine
      }
      return snapshot;
    }

    const content = await fs.readFile(snapshot.filePath, 'utf-8');
    await fs.writeFile(resolvedPath, content, 'utf-8');
    return snapshot;
  }

  /**
   * Prune old snapshots for a file.
   *
   * Strategy:
   *  1. Keep the most recent `maxSnapshots` snapshots by count.
   *  2. Among the rest, delete any older than `ttlMs`.
   */
  async pruneSnapshots(filePath: string): Promise<void> {
    const snapshots = await this.listSnapshots(filePath);

    if (snapshots.length <= this.maxSnapshots) {
      return;
    }

    const now = Date.now();
    const toDelete: string[] = [];

    // Keep the first maxSnapshots (most recent); delete the rest if expired
    for (let i = this.maxSnapshots; i < snapshots.length; i++) {
      const age = now - snapshots[i].epochMs;
      if (age > this.ttlMs) {
        toDelete.push(snapshots[i].filePath);
      }
    }

    // Batch delete
    await Promise.allSettled(
      toDelete.map((fp) => fs.unlink(fp).catch(() => {})),
    );
  }
}
