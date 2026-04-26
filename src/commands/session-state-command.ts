import { failureResult, successResult, type CommandResult } from '../shared/result';
import type { SessionService } from '../sessions/session-service';
import { SessionCommandError } from './command-errors';

export interface SessionStateCommandDependencies {
  readonly sessionService: SessionService;
  onCurrentSessionChange?: (sessionId: string | null) => void;
}

function withSessionId(
  args: string[],
  action: (sessionId: string) => ReturnType<SessionService['selectSession']>,
  successCode: string,
  successMessage: string,
  onCurrentSessionChange?: (sessionId: string | null, status?: string) => void,
): CommandResult {
  const sessionId = args[0]?.trim();

  if (!sessionId) {
    return failureResult('SESSION_ID_REQUIRED', 'Session id is required', ['Provide a session id.']);
  }

  try {
    const session = action(sessionId);
    onCurrentSessionChange?.(session.status === 'active' ? session.id : null, session.status);
    return successResult(successCode, successMessage, session);
  } catch (error) {
    if (error instanceof SessionCommandError) {
      return failureResult('SESSION_COMMAND_FAILED', error.message, ['Check the session id and current state.']);
    }

    throw error;
  }
}

export function createSessionSelectCommand(dependencies: SessionStateCommandDependencies) {
  return (args: string[]): CommandResult =>
    withSessionId(
      args,
      (sessionId) => dependencies.sessionService.selectSession(sessionId),
      'SESSION_SELECTED',
      'Session selected',
      dependencies.onCurrentSessionChange,
    );
}

export function createSessionArchiveCommand(dependencies: SessionStateCommandDependencies) {
  return (args: string[]): CommandResult =>
    withSessionId(
      args,
      (sessionId) => dependencies.sessionService.archiveSession(sessionId),
      'SESSION_ARCHIVED',
      'Session archived',
      dependencies.onCurrentSessionChange,
    );
}

export function createSessionRestoreCommand(dependencies: SessionStateCommandDependencies) {
  return (args: string[]): CommandResult =>
    withSessionId(
      args,
      (sessionId) => dependencies.sessionService.restoreSession(sessionId),
      'SESSION_RESTORED',
      'Session restored',
      dependencies.onCurrentSessionChange,
    );
}

export function createSessionDeleteCommand(dependencies: SessionStateCommandDependencies) {
  return (args: string[]): CommandResult =>
    withSessionId(
      args,
      (sessionId) => dependencies.sessionService.deleteSession(sessionId),
      'SESSION_DELETED',
      'Session deleted',
      dependencies.onCurrentSessionChange,
    );
}

export function createSessionImportMemoriesCommand(dependencies: SessionStateCommandDependencies & {
  readonly getCurrentSessionId: () => string | null;
}) {
  return (args: string[]): CommandResult => {
    const sourceSessionId = args[0]?.trim();
    const targetSessionId = dependencies.getCurrentSessionId();

    if (!targetSessionId) {
      return failureResult('SESSION_REQUIRED', 'Create or select a target session before importing memories', [
        'Use /new or /session-sel to activate a session, then retry.',
      ]);
    }

    if (!sourceSessionId) {
      return failureResult('SESSION_ID_REQUIRED', 'Source session id is required', ['Use /session-import-memories <session-id>.']);
    }

    try {
      const session = dependencies.sessionService.importSelectedMemoriesFromSession(targetSessionId, sourceSessionId);
      return successResult('SESSION_MEMORIES_IMPORTED', 'Session memories imported', session);
    } catch (error) {
      if (error instanceof SessionCommandError) {
        return failureResult('SESSION_COMMAND_FAILED', error.message, ['Check the session ids and current state.']);
      }

      throw error;
    }
  };
}
