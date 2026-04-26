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
    const profile = this.getProfileTemplate(profileId);

    if (!profile) {
      throw new Error(`Agent profile template not found: ${profileId}`);
    }

    return this.repository.create(profile, workspaceRoot);
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
}