import fs from 'node:fs';
import path from 'node:path';
import type { PepeConfig } from '../shared/config';

export const SKILL_INSTRUCTION_FILE_NAME = 'SKILL.md';

export interface PuebloSkillSummary {
  readonly id: string;
  readonly instructionPath: string;
  readonly description: string | null;
}

export interface SkillContextSnapshot {
  readonly puebloWorkingDirectory: string;
  readonly agentWorkingDirectory: string;
  readonly skillDirectory: string;
  readonly skills: PuebloSkillSummary[];
}

export function resolveAgentWorkingDirectory(
  puebloWorkingDirectory: string,
  agentInstanceId: string,
  config: Pick<PepeConfig, 'workingDirectoryPattern'>,
): string {
  const agentDirectoryName = config.workingDirectoryPattern.replace('{agentInstanceId}', agentInstanceId);
  return path.join(puebloWorkingDirectory, agentDirectoryName);
}

export function resolveSkillContext(args: {
  readonly puebloWorkingDirectory: string | null | undefined;
  readonly agentInstanceId: string | null | undefined;
  readonly config: Pick<PepeConfig, 'workingDirectoryPattern' | 'skillDirectoryName'>;
}): SkillContextSnapshot | null {
  if (!args.puebloWorkingDirectory || !args.agentInstanceId) {
    return null;
  }

  const puebloWorkingDirectory = path.resolve(args.puebloWorkingDirectory);
  const agentWorkingDirectory = resolveAgentWorkingDirectory(puebloWorkingDirectory, args.agentInstanceId, args.config);
  const skillDirectory = path.join(agentWorkingDirectory, args.config.skillDirectoryName);

  return {
    puebloWorkingDirectory,
    agentWorkingDirectory,
    skillDirectory,
    skills: readSkillSummaries(puebloWorkingDirectory, skillDirectory),
  };
}

export function buildSkillSystemMessage(skillContext: SkillContextSnapshot | null | undefined): string | null {
  if (!skillContext) {
    return null;
  }

  const lines = [
    'Pueblo skill workspace:',
    `- Pueblo startup directory: ${skillContext.puebloWorkingDirectory}`,
    `- Pueblo working directory: ${skillContext.agentWorkingDirectory}`,
    `- Skill directory: ${skillContext.skillDirectory}`,
    `- Store each reusable skill as <skill-directory>/<skill-id>/${SKILL_INSTRUCTION_FILE_NAME}.`,
    '- When a completed task yields a stable, reusable multi-step procedure, propose turning that procedure into a skill.',
    '- Before creating, updating, or overwriting a skill, explain why it is reusable and wait for explicit user approval.',
    '- After approval, write the skill only inside the Pueblo skill directory, never in the workspace root.',
    '- Skills are installed in the Pueblo startup directory, but the data they process and the files they create should still come from the active target repository or workspace unless the user says otherwise.',
    '- A useful skill should summarize purpose, when to use it, required inputs, concrete steps, validation, and limits.',
    `- To reuse a skill, read its ${SKILL_INSTRUCTION_FILE_NAME} file and follow it as an internal procedure with your existing tools.`,
  ];

  if (skillContext.skills.length === 0) {
    lines.push('- No custom skills are currently installed in this Pueblo skill directory.');
    return lines.join('\n');
  }

  lines.push('Available custom skills:');
  for (const skill of skillContext.skills) {
    lines.push(`- ${skill.id}: ${skill.description ?? 'No description provided.'} (${skill.instructionPath})`);
  }

  return lines.join('\n');
}

function readSkillSummaries(puebloWorkingDirectory: string, skillDirectory: string): PuebloSkillSummary[] {
  if (!fs.existsSync(skillDirectory)) {
    return [];
  }

  return fs.readdirSync(skillDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const instructionAbsolutePath = path.join(skillDirectory, entry.name, SKILL_INSTRUCTION_FILE_NAME);
      if (!fs.existsSync(instructionAbsolutePath) || !fs.statSync(instructionAbsolutePath).isFile()) {
        return [];
      }

      const content = fs.readFileSync(instructionAbsolutePath, 'utf8');
      return [{
        id: entry.name,
        instructionPath: normalizePromptPath(path.relative(puebloWorkingDirectory, instructionAbsolutePath)),
        description: extractSkillDescription(content),
      }];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function extractSkillDescription(content: string): string | null {
  const normalizedLines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of normalizedLines) {
    if (line.startsWith('#')) {
      continue;
    }

    const normalized = line.replace(/^[-*]\s+/, '').trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return null;
}

function normalizePromptPath(value: string): string {
  return value.split(path.sep).join('/');
}