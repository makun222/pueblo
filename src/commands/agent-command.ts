import { failureResult, successResult, type CommandResult } from '../shared/result';
import type { AgentProfileTemplate } from '../shared/schema';

export interface AgentCommandDependencies {
  readonly listAgentProfiles: () => AgentProfileTemplate[];
  readonly startAgentSession: (profileId: string) => Promise<unknown>;
}

export function createAgentCommand(
  dependencies: AgentCommandDependencies,
): (args: string[]) => Promise<CommandResult> {
  const { listAgentProfiles, startAgentSession } = dependencies;

  return async (args: string[]): Promise<CommandResult> => {
    try {
      if (args.length === 0) {
        // /agent list — show available agent profiles
        const profiles = listAgentProfiles();
        if (profiles.length === 0) {
          return successResult('AGENT_LIST', 'No agent profiles available.', { profiles: [] });
        }
        const lines = profiles.map(
          (p) => `  ${p.id}${p.id !== p.name ? `  (${p.name})` : ''}`,
        );
        return successResult(
          'AGENT_LIST',
          `Available agent profiles (${profiles.length}):\n${lines.join('\n')}`,
          { profiles },
        );
      }

      // /agent switch <profileName>
      const [profileName] = args;
      const profiles = listAgentProfiles();
      const profile = profiles.find(
        (p) => p.id === profileName || (p as Record<string, unknown>).name === profileName,
      );
      if (!profile) {
        return failureResult('AGENT_NOT_FOUND', `Agent profile "${profileName}" not found.`, [
          'Use /agent to list available agent profiles.',
        ]);
      }

      await startAgentSession(profile.id);
      return successResult(
        'AGENT_SWITCHED',
        `Switched to agent profile "${profile.id}".`,
        { profileId: profile.id },
      );
    } catch (error) {
      return failureResult(
        'AGENT_SWITCH_FAILED',
        `Failed to switch agent profile: ${(error as Error).message}`,
        ['Use /agent to list available agent profiles.'],
      );
    }
  };
}
