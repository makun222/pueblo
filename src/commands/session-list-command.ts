import { failureResult, successResult, type CommandResult } from '../shared/result';
import type { SessionService } from '../sessions/session-service';

export interface SessionListCommandDependencies {
  readonly sessionService: SessionService;
  readonly getAgentInstanceId?: () => string | null;
  onCurrentSessionChange?: (sessionId: string | null) => void;
}

export function createNewSessionCommand(dependencies: SessionListCommandDependencies) {
  return (args: string[]): CommandResult => {
    const title = args.join(' ').trim();
    const session = dependencies.sessionService.createSession(title, null, dependencies.getAgentInstanceId?.() ?? null);
    dependencies.onCurrentSessionChange?.(session.id);

    return successResult('SESSION_CREATED', 'Session created', session);
  };
}

export function createSessionListCommand(dependencies: SessionListCommandDependencies) {
  return (): CommandResult => {
    const sessions = dependencies.sessionService.listSessions();

    if (sessions.length === 0) {
      return failureResult('SESSION_LIST_EMPTY', 'No sessions found', ['Use /new to create a session.']);
    }

    return successResult('SESSION_LIST', 'Sessions loaded', {
      sessions,
    });
  };
}
