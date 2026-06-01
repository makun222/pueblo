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
    `- Pueblo启动目录: ${skillContext.puebloWorkingDirectory}`,
    `- workspace目录: ${skillContext.agentWorkingDirectory}`,
    `- Pueblo Skill目录: ${skillContext.skillDirectory}`,
    '- 如果任务完成过程是一个稳定的、可重用的多步骤过程时，建议将该过程转化为Skill。',
    '- 一个有用的Skill应总结其目的、使用时机、所需输入、具体步骤、验证和限制。',
    `- Skill保存为： <Pueblo Skill>/<skill-id>/${SKILL_INSTRUCTION_FILE_NAME}.`,
    '- 在创建、更新或覆盖Skill之前，需要用户的明确批准。',
    '- 一般，Skill处理的数据和创建的文件存储在workspace目录，除非用户另有说明。',
    `- 要重用Skill，请阅读其 ${SKILL_INSTRUCTION_FILE_NAME} 文件，并按照其中的说明作为内部流程使用现有工具。`,
  ];

  if (skillContext.skills.length === 0) {
    lines.push('- 当前Pueblo Skill目录中没有安装自定义Skill。');
    return lines.join('\n');
  }

  lines.push('可用的自定义Skill:');
  for (const skill of skillContext.skills) {
    lines.push(`- ${skill.id}: ${skill.description ?? '未提供描述。'} (${skill.instructionPath})`);
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