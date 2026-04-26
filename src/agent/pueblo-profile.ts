import fs from 'node:fs';
import path from 'node:path';
import { puebloProfileSchema, type PuebloProfile } from '../shared/schema';

const SECTION_KEYS = new Map<string, keyof ParsedSections>([
  ['role', 'role'],
  ['goals', 'goals'],
  ['constraints', 'constraints'],
  ['style', 'style'],
  ['memory policy', 'memoryPolicy'],
  ['context policy', 'contextPolicy'],
  ['summary policy', 'summaryPolicy'],
]);

interface ParsedSections {
  role: string[];
  goals: string[];
  constraints: string[];
  style: string[];
  memoryPolicy: string[];
  contextPolicy: string[];
  summaryPolicy: string[];
}

export class PuebloProfileLoader {
  private cachedPath: string | null = null;
  private cachedMtimeMs: number | null = null;
  private cachedProfile: PuebloProfile | null = null;

  load(startDir: string): PuebloProfile {
    const profilePath = findPuebloProfilePath(startDir);

    if (!profilePath) {
      return createEmptyPuebloProfile(null);
    }

    const stats = fs.statSync(profilePath);
    if (this.cachedProfile && this.cachedPath === profilePath && this.cachedMtimeMs === stats.mtimeMs) {
      return this.cachedProfile;
    }

    const parsed = parsePuebloProfile(fs.readFileSync(profilePath, 'utf8'), profilePath);
    this.cachedPath = profilePath;
    this.cachedMtimeMs = stats.mtimeMs;
    this.cachedProfile = parsed;
    return parsed;
  }
}

export function findWorkspaceRoot(startDir: string): string | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json');

    if (fs.existsSync(packageJsonPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

export function createEmptyPuebloProfile(loadedFromPath: string | null): PuebloProfile {
  return puebloProfileSchema.parse({
    roleDirectives: [],
    goalDirectives: [],
    constraintDirectives: [],
    styleDirectives: [],
    memoryPolicy: {
      retentionHints: [],
      summaryHints: [],
    },
    contextPolicy: {
      priorityHints: [],
      truncationHints: [],
    },
    summaryPolicy: {
      autoSummarize: true,
      thresholdHint: null,
      lineageHint: null,
    },
    loadedFromPath,
    loadedAt: new Date().toISOString(),
  });
}

export function parsePuebloProfile(content: string, loadedFromPath: string | null): PuebloProfile {
  const sections = createEmptySections();
  let currentKey: keyof ParsedSections | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const heading = rawLine.match(/^#{1,2}\s+(.*?)\s*$/);

    if (heading) {
      currentKey = SECTION_KEYS.get(heading[1].trim().toLowerCase()) ?? null;
      continue;
    }

    if (!currentKey) {
      continue;
    }

    const normalized = normalizeDirectiveLine(rawLine);
    if (normalized) {
      sections[currentKey].push(normalized);
    }
  }

  return puebloProfileSchema.parse({
    roleDirectives: sections.role,
    goalDirectives: sections.goals,
    constraintDirectives: sections.constraints,
    styleDirectives: sections.style,
    memoryPolicy: {
      retentionHints: sections.memoryPolicy.filter((line) => !line.toLowerCase().startsWith('summary:')),
      summaryHints: sections.memoryPolicy
        .filter((line) => line.toLowerCase().startsWith('summary:'))
        .map((line) => line.slice('summary:'.length).trim())
        .filter(Boolean),
    },
    contextPolicy: {
      priorityHints: sections.contextPolicy.filter((line) => !line.toLowerCase().startsWith('truncate:')),
      truncationHints: sections.contextPolicy
        .filter((line) => line.toLowerCase().startsWith('truncate:'))
        .map((line) => line.slice('truncate:'.length).trim())
        .filter(Boolean),
    },
    summaryPolicy: {
      autoSummarize: !sections.summaryPolicy.some((line) => /manual/i.test(line)),
      thresholdHint: extractThresholdHint(sections.summaryPolicy),
      lineageHint: sections.summaryPolicy.find((line) => /^lineage:/i.test(line))?.replace(/^lineage:/i, '').trim() ?? null,
    },
    loadedFromPath,
    loadedAt: new Date().toISOString(),
  });
}

function createEmptySections(): ParsedSections {
  return {
    role: [],
    goals: [],
    constraints: [],
    style: [],
    memoryPolicy: [],
    contextPolicy: [],
    summaryPolicy: [],
  };
}

function normalizeDirectiveLine(line: string): string | null {
  const normalized = line.trim().replace(/^[-*]\s+/, '');
  return normalized.length > 0 ? normalized : null;
}

function extractThresholdHint(lines: string[]): number | null {
  for (const line of lines) {
    const match = line.match(/(\d{2,6})/);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }

  return null;
}

function findPuebloProfilePath(startDir: string): string | null {
  const workspaceRoot = findWorkspaceRoot(startDir);
  if (!workspaceRoot) {
    return null;
  }

  const puebloPath = path.join(workspaceRoot, 'pueblo.md');
  return fs.existsSync(puebloPath) ? puebloPath : null;
}