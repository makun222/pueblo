import { randomUUID } from 'node:crypto';
import { RepositoryBase, type RepositoryContext } from '../persistence/repository-base';
import { agentInstanceSchema, type AgentInstance, type AgentProfileTemplate } from '../shared/schema';

interface AgentInstanceRow {
  id: string;
  profile_id: string;
  profile_name: string;
  status: AgentInstance['status'];
  is_default_for_profile: number;
  workspace_root: string;
  created_at: string;
  updated_at: string;
  terminated_at: string | null;
}

export interface AgentInstanceStore {
  create(profile: AgentProfileTemplate, workspaceRoot: string, isDefaultForProfile?: boolean): AgentInstance;
  list(): AgentInstance[];
  getById(agentInstanceId: string): AgentInstance | null;
  getDefaultByProfile(profileId: string): AgentInstance | null;
  save(instance: AgentInstance): AgentInstance;
}

export class InMemoryAgentInstanceRepository implements AgentInstanceStore {
  private readonly instances = new Map<string, AgentInstance>();

  create(profile: AgentProfileTemplate, workspaceRoot: string, isDefaultForProfile = false): AgentInstance {
    const now = new Date().toISOString();
    const instance = agentInstanceSchema.parse({
      id: randomUUID(),
      profileId: profile.id,
      profileName: profile.name,
      status: 'ready',
      isDefaultForProfile,
      workspaceRoot,
      createdAt: now,
      updatedAt: now,
      terminatedAt: null,
    });
    this.instances.set(instance.id, instance);
    return instance;
  }

  list(): AgentInstance[] {
    return [...this.instances.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  getById(agentInstanceId: string): AgentInstance | null {
    return this.instances.get(agentInstanceId) ?? null;
  }

  getDefaultByProfile(profileId: string): AgentInstance | null {
    return [...this.instances.values()]
      .filter((instance) => instance.profileId === profileId && instance.isDefaultForProfile && instance.status !== 'terminated')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  }

  save(instance: AgentInstance): AgentInstance {
    this.instances.set(instance.id, instance);
    return instance;
  }
}

export class AgentInstanceRepository extends RepositoryBase implements AgentInstanceStore {
  constructor(context: RepositoryContext) {
    super(context);
  }

  create(profile: AgentProfileTemplate, workspaceRoot: string, isDefaultForProfile = false): AgentInstance {
    const now = new Date().toISOString();
    const instance = agentInstanceSchema.parse({
      id: randomUUID(),
      profileId: profile.id,
      profileName: profile.name,
      status: 'ready',
      isDefaultForProfile,
      workspaceRoot,
      createdAt: now,
      updatedAt: now,
      terminatedAt: null,
    });
    this.save(instance);
    return instance;
  }

  list(): AgentInstance[] {
    const rows = this.all<AgentInstanceRow>('SELECT * FROM agent_instances ORDER BY updated_at DESC');
    return rows.map((row) => this.mapRow(row));
  }

  getById(agentInstanceId: string): AgentInstance | null {
    const row = this.get<AgentInstanceRow>('SELECT * FROM agent_instances WHERE id = ?', [agentInstanceId]);
    return row ? this.mapRow(row) : null;
  }

  getDefaultByProfile(profileId: string): AgentInstance | null {
    const row = this.get<AgentInstanceRow>(
      `SELECT *
         FROM agent_instances
        WHERE profile_id = ?
          AND is_default_for_profile = 1
          AND status != 'terminated'
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1`,
      [profileId],
    );
    return row ? this.mapRow(row) : null;
  }

  save(instance: AgentInstance): AgentInstance {
    const existing = this.getById(instance.id);
    const params = {
      id: instance.id,
      profile_id: instance.profileId,
      profile_name: instance.profileName,
      status: instance.status,
      is_default_for_profile: instance.isDefaultForProfile ? 1 : 0,
      workspace_root: instance.workspaceRoot,
      created_at: instance.createdAt,
      updated_at: instance.updatedAt,
      terminated_at: instance.terminatedAt,
    };

    if (existing) {
      this.run(
        `UPDATE agent_instances
         SET profile_id=@profile_id, profile_name=@profile_name, status=@status,
           is_default_for_profile=@is_default_for_profile,
             workspace_root=@workspace_root, created_at=@created_at,
             updated_at=@updated_at, terminated_at=@terminated_at
         WHERE id=@id`,
        params,
      );
    } else {
      this.run(
        `INSERT INTO agent_instances (
          id, profile_id, profile_name, status, is_default_for_profile, workspace_root, created_at, updated_at, terminated_at
        ) VALUES (
          @id, @profile_id, @profile_name, @status, @is_default_for_profile, @workspace_root, @created_at, @updated_at, @terminated_at
        )`,
        params,
      );
    }

    return instance;
  }

  private mapRow(row: AgentInstanceRow): AgentInstance {
    return agentInstanceSchema.parse({
      id: row.id,
      profileId: row.profile_id,
      profileName: row.profile_name,
      status: row.status,
      isDefaultForProfile: row.is_default_for_profile === 1,
      workspaceRoot: row.workspace_root,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      terminatedAt: row.terminated_at,
    });
  }
}