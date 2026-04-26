import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { agentProfileTemplateSchema, type AgentProfileTemplate } from '../shared/schema';
import { findWorkspaceRoot } from './pueblo-profile';

const AGENT_TEMPLATE_SECTION_KEYS = new Map<string, keyof ParsedTemplateSections>([
  ['profile', 'profile'],
  ['role', 'role'],
  ['goals', 'goals'],
  ['constraints', 'constraints'],
  ['style', 'style'],
  ['memory policy', 'memoryPolicy'],
  ['context policy', 'contextPolicy'],
  ['summary policy', 'summaryPolicy'],
]);

interface ParsedTemplateSections {
  profile: string[];
  role: string[];
  goals: string[];
  constraints: string[];
  style: string[];
  memoryPolicy: string[];
  contextPolicy: string[];
  summaryPolicy: string[];
}

interface AgentTemplateSyncState {
  sourceDigest: string | null;
}

export class AgentTemplateLoader {
  constructor(private readonly startDir: string) {}

  list(): AgentProfileTemplate[] {
    const templatesDir = resolveAgentTemplatesDir(this.startDir);
    syncAgentTemplatesFromSource(templatesDir);

    return fs.readdirSync(templatesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const templatePath = path.join(templatesDir, entry.name, 'agent.md');
        if (!fs.existsSync(templatePath)) {
          return [];
        }

        return [parseAgentTemplate(fs.readFileSync(templatePath, 'utf8'), templatePath, entry.name)];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  get(profileId: string): AgentProfileTemplate | null {
    const templatePath = resolveAgentTemplateFilePath(this.startDir, profileId);
    syncAgentTemplatesFromSource(path.dirname(path.dirname(templatePath)));

    if (!fs.existsSync(templatePath)) {
      return null;
    }

    return parseAgentTemplate(fs.readFileSync(templatePath, 'utf8'), templatePath, profileId);
  }

  save(profileId: string, markdown: string): AgentProfileTemplate {
    const templatePath = resolveAgentTemplateFilePath(this.startDir, profileId);
    const templatesDir = path.dirname(path.dirname(templatePath));
    syncAgentTemplatesFromSource(templatesDir);
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    fs.writeFileSync(templatePath, markdown, 'utf8');
    persistTemplateSyncState(templatesDir, profileId, {
      sourceDigest: readSourceTemplateDigest(templatesDir, profileId),
    });
    return parseAgentTemplate(markdown, templatePath, profileId);
  }
}

export function resolveAgentTemplatesDir(startDir: string): string {
  const workspaceRoot = findWorkspaceRoot(startDir) ?? path.resolve(startDir);
  return path.join(workspaceRoot, '.pueblo', 'agents', 'templates');
}

export function resolveSeedAgentProfilesDir(startDir: string): string {
  const workspaceRoot = findWorkspaceRoot(startDir) ?? path.resolve(startDir);
  return path.join(workspaceRoot, 'puebl-profile');
}

export function resolveAgentTemplateFilePath(startDir: string, profileId: string): string {
  return path.join(resolveAgentTemplatesDir(startDir), profileId, 'agent.md');
}

function resolveAgentTemplateStateFilePath(templatesDir: string, profileId: string): string {
  return path.join(templatesDir, profileId, '.template-sync.json');
}

export function parseAgentTemplate(content: string, loadedFromPath: string, fallbackId: string): AgentProfileTemplate {
  const sections = createEmptyTemplateSections();
  let currentKey: keyof ParsedTemplateSections | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const heading = rawLine.match(/^#{1,2}\s+(.*?)\s*$/);

    if (heading) {
      currentKey = AGENT_TEMPLATE_SECTION_KEYS.get(heading[1].trim().toLowerCase()) ?? null;
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

  const profileMetadata = parseProfileMetadata(sections.profile, fallbackId);

  return agentProfileTemplateSchema.parse({
    id: profileMetadata.id,
    name: profileMetadata.name,
    description: profileMetadata.description,
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
  });
}

function syncAgentTemplatesFromSource(templatesDir: string): void {
  fs.mkdirSync(templatesDir, { recursive: true });

  const sourceTemplatesDir = resolveSeedAgentProfilesDir(templatesDir);
  if (!fs.existsSync(sourceTemplatesDir)) {
    return;
  }

  for (const entry of fs.readdirSync(sourceTemplatesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourceTemplatePath = path.join(sourceTemplatesDir, entry.name, 'agent.md');
    if (!fs.existsSync(sourceTemplatePath)) {
      continue;
    }

    const sourceContent = fs.readFileSync(sourceTemplatePath, 'utf8');
    const sourceDigest = hashTemplateContent(sourceContent);
    const templateDir = path.join(templatesDir, entry.name);
    const templatePath = path.join(templateDir, 'agent.md');
    const statePath = resolveAgentTemplateStateFilePath(templatesDir, entry.name);

    if (!fs.existsSync(templatePath)) {
      fs.mkdirSync(templateDir, { recursive: true });
      fs.writeFileSync(templatePath, sourceContent, 'utf8');
      persistTemplateSyncState(templatesDir, entry.name, { sourceDigest });
      continue;
    }

    const runtimeContent = fs.readFileSync(templatePath, 'utf8');
    const runtimeDigest = hashTemplateContent(runtimeContent);
    const syncState = readTemplateSyncState(statePath);

    if (syncState?.sourceDigest === sourceDigest) {
      continue;
    }

    if (syncState && runtimeDigest !== syncState.sourceDigest) {
      continue;
    }

    if (!syncState && fs.statSync(templatePath).mtimeMs > fs.statSync(sourceTemplatePath).mtimeMs) {
      continue;
    }

    fs.writeFileSync(templatePath, sourceContent, 'utf8');
    persistTemplateSyncState(templatesDir, entry.name, { sourceDigest });
  }
}

function readTemplateSyncState(statePath: string): AgentTemplateSyncState | null {
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<AgentTemplateSyncState>;
    return {
      sourceDigest: typeof parsed.sourceDigest === 'string' ? parsed.sourceDigest : null,
    };
  } catch {
    return null;
  }
}

function persistTemplateSyncState(templatesDir: string, profileId: string, state: AgentTemplateSyncState): void {
  const statePath = resolveAgentTemplateStateFilePath(templatesDir, profileId);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function readSourceTemplateDigest(templatesDir: string, profileId: string): string | null {
  const sourceTemplatePath = path.join(resolveSeedAgentProfilesDir(templatesDir), profileId, 'agent.md');
  if (!fs.existsSync(sourceTemplatePath)) {
    return null;
  }

  return hashTemplateContent(fs.readFileSync(sourceTemplatePath, 'utf8'));
}

function hashTemplateContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseProfileMetadata(lines: string[], fallbackId: string): { id: string; name: string; description: string } {
  const metadata = new Map<string, string>();

  for (const line of lines) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (!value) {
      continue;
    }

    metadata.set(key, value);
  }

  return {
    id: metadata.get('id') ?? fallbackId,
    name: metadata.get('name') ?? fallbackId,
    description: metadata.get('description') ?? `${metadata.get('name') ?? fallbackId} agent profile.`,
  };
}

function createEmptyTemplateSections(): ParsedTemplateSections {
  return {
    profile: [],
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