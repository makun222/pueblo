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

function toSkillPayload(skill: PuebloSkillSummary) {
  return {
    id: skill.id,
    instructionPath: skill.instructionPath,
    description: skill.description,
  };
}