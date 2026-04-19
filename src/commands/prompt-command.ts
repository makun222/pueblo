import { failureResult, successResult, type CommandResult } from '../shared/result';
import type { PromptService } from '../prompts/prompt-service';
import type { SessionService } from '../sessions/session-service';

export interface PromptCommandDependencies {
  readonly promptService: PromptService;
  readonly sessionService: SessionService;
  readonly getCurrentSessionId: () => string | null;
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
    const sessionId = dependencies.getCurrentSessionId();

    if (!sessionId) {
      return failureResult('SESSION_REQUIRED', 'Create or select a session before selecting a prompt', [
        'Use /new to create a session, then retry /prompt-sel.',
      ]);
    }

    dependencies.sessionService.addSelectedPrompt(sessionId, prompt.id);
    return successResult('PROMPT_SELECTED', 'Prompt selected', prompt);
  };
}

export function createPromptDeleteCommand(dependencies: PromptCommandDependencies) {
  return (args: string[]): CommandResult => {
    const promptId = args[0];

    if (!promptId) {
      return failureResult('PROMPT_ID_REQUIRED', 'Prompt id is required', ['Use /prompt-del <id>.']);
    }

    const deleted = dependencies.promptService.deletePrompt(promptId);
    const sessionId = dependencies.getCurrentSessionId();

    if (sessionId) {
      dependencies.sessionService.removeSelectedPrompt(sessionId, promptId);
    }

    return successResult('PROMPT_DELETED', 'Prompt deleted', deleted);
  };
}
