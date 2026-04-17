import { failureResult, successResult, type CommandResult } from '../shared/result';
import type { PromptService } from '../prompts/prompt-service';

export interface PromptCommandDependencies {
  readonly promptService: PromptService;
  readonly selectedPromptIds: Set<string>;
}

export function createPromptListCommand(dependencies: PromptCommandDependencies) {
  return (): CommandResult => successResult('PROMPT_LIST', 'Prompts loaded', { prompts: dependencies.promptService.listPrompts() });
}

export function createPromptAddCommand(dependencies: PromptCommandDependencies) {
  return (args: string[]): CommandResult => {
    const [title, category, ...contentParts] = args;
    const content = contentParts.join(' ').trim();

    if (!title || !category || !content) {
      return failureResult('PROMPT_ADD_INVALID', 'Prompt title, category, and content are required', [
        'Use /prompt-add <title> <category> <content>.',
      ]);
    }

    return successResult('PROMPT_CREATED', 'Prompt created', dependencies.promptService.createPrompt(title, category, content));
  };
}

export function createPromptSelectCommand(dependencies: PromptCommandDependencies) {
  return (args: string[]): CommandResult => {
    const promptId = args[0];

    if (!promptId) {
      return failureResult('PROMPT_ID_REQUIRED', 'Prompt id is required', ['Use /prompt-sel <id>.']);
    }

    const prompt = dependencies.promptService.selectPrompt(promptId);
    dependencies.selectedPromptIds.add(prompt.id);
    return successResult('PROMPT_SELECTED', 'Prompt selected', prompt);
  };
}

export function createPromptDeleteCommand(dependencies: PromptCommandDependencies) {
  return (args: string[]): CommandResult => {
    const promptId = args[0];

    if (!promptId) {
      return failureResult('PROMPT_ID_REQUIRED', 'Prompt id is required', ['Use /prompt-del <id>.']);
    }

    dependencies.selectedPromptIds.delete(promptId);
    return successResult('PROMPT_DELETED', 'Prompt deleted', dependencies.promptService.deletePrompt(promptId));
  };
}
