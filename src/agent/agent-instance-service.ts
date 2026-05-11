import type { AgentInstance, AgentProfileTemplate } from '../shared/schema';
import { AgentTemplateLoader } from './agent-template-loader';
import type { AgentInstanceStore } from './agent-instance-repository';

export class AgentInstanceService {
  constructor(
    private readonly repository: AgentInstanceStore,
    private readonly templateLoader: AgentTemplateLoader = new AgentTemplateLoader(process.cwd()),
  ) {}

  listProfileTemplates(): AgentProfileTemplate[] {
    return this.templateLoader.list();
  }

  getProfileTemplate(profileId: string): AgentProfileTemplate | null {
    return this.templateLoader.get(profileId);
  }

  createAgentInstance(profileId: string, workspaceRoot: string): AgentInstance {
    const profile = this.requireProfileTemplate(profileId);
    return this.repository.create(profile, workspaceRoot, false);
  }

  getDefaultAgentInstance(profileId: string): AgentInstance | null {
    return this.repository.getDefaultByProfile(profileId);
  }

  getOrCreateDefaultAgentInstance(profileId: string, workspaceRoot: string): AgentInstance {
    const existing = this.getDefaultAgentInstance(profileId);
    if (existing) {
      return existing;
    }

    const legacyCandidate = this.repository.list()
      .filter((instance) => instance.profileId === profileId && instance.status !== 'terminated')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))[0] ?? null;

    if (legacyCandidate) {
      return this.setDefaultAgentInstance(profileId, legacyCandidate.id);
    }

    const profile = this.requireProfileTemplate(profileId);
    return this.repository.create(profile, workspaceRoot, true);
  }

  getAgentInstance(agentInstanceId: string | null | undefined): AgentInstance | null {
    if (!agentInstanceId) {
      return null;
    }

    return this.repository.getById(agentInstanceId);
  }

  markActive(agentInstanceId: string): AgentInstance {
    const existing = this.getAgentInstance(agentInstanceId);
    if (!existing) {
      throw new Error(`Agent instance not found: ${agentInstanceId}`);
    }

    const updated: AgentInstance = {
      ...existing,
      status: 'active',
      updatedAt: new Date().toISOString(),
    };

    return this.repository.save(updated);
  }

  private setDefaultAgentInstance(profileId: string, agentInstanceId: string): AgentInstance {
    let promoted: AgentInstance | null = null;

    for (const instance of this.repository.list().filter((item) => item.profileId === profileId)) {
      const shouldBeDefault = instance.id === agentInstanceId;
      if (instance.isDefaultForProfile === shouldBeDefault) {
        if (shouldBeDefault) {
          promoted = instance;
        }
        continue;
      }

      const updated = this.repository.save({
        ...instance,
        isDefaultForProfile: shouldBeDefault,
        updatedAt: new Date().toISOString(),
      });

      if (shouldBeDefault) {
        promoted = updated;
      }
    }

    if (!promoted) {
      throw new Error(`Unable to promote default agent instance for profile: ${profileId}`);
    }

    return promoted;
  }

  private requireProfileTemplate(profileId: string): AgentProfileTemplate {
    const profile = this.getProfileTemplate(profileId);

    if (!profile) {
      throw new Error(`Agent profile template not found: ${profileId}`);
    }

    return profile;
  }
}