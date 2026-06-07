import fs from 'node:fs';
import path from 'node:path';
import type { PepeConfig } from '../shared/config';
import { failureResult, successResult, type CommandResult } from '../shared/result';
import {
  resolveSkillContext,
  SKILL_INSTRUCTION_FILE_NAME,
  type PuebloSkillSummary,
} from '../agent/skill-context';

export interface SkillCommandDependencies {
  readonly puebloWorkingDirectory: string;
  readonly config: Pick<PepeConfig, 'workingDirectoryPattern' | 'skillDirectoryName'>;
  readonly ensureCurrentAgentInstanceId: () => string;
}

export function createSkillListCommand(dependencies: SkillCommandDependencies) {
  return (): CommandResult => {
    const skillContext = resolveSkillContext({
      puebloWorkingDirectory: dependencies.puebloWorkingDirectory,
      agentInstanceId: dependencies.ensureCurrentAgentInstanceId(),
      config: dependencies.config,
    });

    if (!skillContext) {
      return failureResult('SKILL_CONTEXT_UNAVAILABLE', 'Unable to resolve the Pueblo skill directory for the current agent.', [
        'Select or start an agent session, then retry /skill-list.',
      ]);
    }

    return successResult('SKILL_LIST', 'Installed skills loaded', {
      puebloWorkingDirectory: skillContext.puebloWorkingDirectory,
      skillDirectory: skillContext.skillDirectory,
      skills: skillContext.skills,
    });
  };
}

export function createSkillOpenCommand(dependencies: SkillCommandDependencies) {
  return (args: string[]): CommandResult => {
    const skillId = args[0]?.trim();

    if (!skillId) {
      return failureResult('SKILL_ID_REQUIRED', 'Skill id is required.', [
        'Use /skill-open <skill-id>.',
      ]);
    }

    const skillContext = resolveSkillContext({
      puebloWorkingDirectory: dependencies.puebloWorkingDirectory,
      agentInstanceId: dependencies.ensureCurrentAgentInstanceId(),
      config: dependencies.config,
    });

    if (!skillContext) {
      return failureResult('SKILL_CONTEXT_UNAVAILABLE', 'Unable to resolve the Pueblo skill directory for the current agent.', [
        'Select or start an agent session, then retry /skill-open.',
      ]);
    }

    const skill = skillContext.skills.find((candidate) => candidate.id === skillId);
    if (!skill) {
      return failureResult('SKILL_NOT_FOUND', `Skill not found: ${skillId}`, [
        'Use /skill-list to inspect installed skills for the current agent.',
      ]);
    }

    const absolutePath = path.join(skillContext.skillDirectory, skill.id, SKILL_INSTRUCTION_FILE_NAME);
    const content = fs.readFileSync(absolutePath, 'utf8');

    return successResult('SKILL_OPEN', 'Skill loaded', {
      skill: toSkillPayload(skill),
      path: absolutePath,
      content,
    });
  };
}

export function createSkillInstallCommand(dependencies: SkillCommandDependencies) {
  return async (args: string[]): Promise<CommandResult> => {
    const sourceDir = args[0]?.trim();

    if (!sourceDir) {
      return failureResult('SOURCE_DIR_REQUIRED', 'Source directory is required.', [
        'Use /skill-install <source-dir>.',
      ]);
    }

    const absoluteSourceDir = path.resolve(sourceDir);
    if (!fs.existsSync(absoluteSourceDir) || !fs.statSync(absoluteSourceDir).isDirectory()) {
      return failureResult(
        'SOURCE_DIR_NOT_FOUND',
        `Source directory not found or not a directory: ${absoluteSourceDir}`,
        ['Verify the path points to an existing directory.'],
      );
    }

    const skillContext = resolveSkillContext({
      puebloWorkingDirectory: dependencies.puebloWorkingDirectory,
      agentInstanceId: dependencies.ensureCurrentAgentInstanceId(),
      config: dependencies.config,
    });

    if (!skillContext) {
      return failureResult(
        'SKILL_CONTEXT_UNAVAILABLE',
        'Unable to resolve the Pueblo skill directory for the current agent.',
        ['Select or start an agent session, then retry /skill-install.'],
      );
    }

    const entries = fs.readdirSync(absoluteSourceDir, { withFileTypes: true });
    const skillDirs = entries.filter((e) => e.isDirectory());

    const installed: { name: string; path: string }[] = [];
    const cancelled: string[] = [];
    const skipped: { name: string; reason: string }[] = [];

    for (const entry of skillDirs) {
      const skillName = entry.name;
      const sourceSkillDir = path.join(absoluteSourceDir, skillName);
      const sourceMdPath = path.join(sourceSkillDir, 'skill.md');
      const targetSkillDir = path.join(skillContext.skillDirectory, skillName);
      const targetMdPath = path.join(targetSkillDir, SKILL_INSTRUCTION_FILE_NAME);

      if (!fs.existsSync(sourceMdPath)) {
        skipped.push({ name: skillName, reason: 'No skill.md found in source directory' });
        continue;
      }

      if (fs.existsSync(targetSkillDir)) {
        cancelled.push(skillName);
        continue;
      }

      copyDirectoryRecursive(sourceSkillDir, targetSkillDir);

      const copiedMdPath = path.join(targetSkillDir, 'skill.md');
      if (fs.existsSync(copiedMdPath)) {
        fs.renameSync(copiedMdPath, targetMdPath);
      }

      installed.push({ name: skillName, path: targetSkillDir });
    }

    return successResult(
      'SKILL_INSTALL_COMPLETE',
      `Installed ${installed.length} skill(s)`,
      {
        sourceDir: absoluteSourceDir,
        targetDir: skillContext.skillDirectory,
        installed,
        cancelled,
        skipped,
      },
    );
  };
}

function copyDirectoryRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function toSkillPayload(skill: PuebloSkillSummary) {
  return {
    id: skill.id,
    instructionPath: skill.instructionPath,
    description: skill.description,
  };
}