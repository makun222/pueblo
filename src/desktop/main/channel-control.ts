// ---------------------------------------------------------------------------
// Desktop ChannelControl
//
// Desktop hosts channels the same way the CLI does — as a "window" onto one
// runtime selection. The window is pinned to a single desktop tab
// (`getChannelTabId`), which is the tab the channel runtime submits input to.
//
// `ChannelControl` is intentionally synchronous for reads (see
// channel-types.ts), while every desktop lookup is async. We therefore keep an
// in-memory snapshot that `refresh()` rebuilds once per inbound message and
// before every command that mutates the selection. This keeps the command
// router untouched while staying read-only for the desktop UI.
// ---------------------------------------------------------------------------

import type {
  ChannelAgentOption,
  ChannelAgentSelection,
  ChannelApprovalDecision,
  ChannelApprovalPrompt,
  ChannelApprovalResult,
  ChannelControl,
  ChannelSessionOption,
  ChannelSessionStatus,
} from '../../channel/channel-types';
import type { AgentProfileTemplate, AgentTaskStatus, Session } from '../../shared/schema';
import type { DesktopRuntimeStatus } from '../shared/ipc-contract';

/** Minimal agent-instance projection the control needs (matches schema.ts). */
export interface DesktopChannelAgentInstance {
  readonly id: string;
  readonly profileId: string;
  readonly profileName: string;
}

/** Minimal session projection the control needs (matches schema.ts). */
export interface DesktopChannelSession {
  readonly id: string;
  readonly title: string;
  readonly status: 'active' | 'archived' | 'deleted';
  readonly agentInstanceId?: string | null;
  readonly updatedAt: string;
}

export interface DesktopChannelControlDeps {
  /** Tab that owns the channel window; null falls back to the host default. */
  readonly getChannelTabId: () => string | null;
  readonly getTabState: (tabId: string | null) => Promise<{ readonly isSubmitting: boolean }>;
  readonly getRuntimeStatus: (tabId: string | null) => Promise<DesktopRuntimeStatus>;
  readonly listAgentProfiles: () => Promise<readonly AgentProfileTemplate[]>;
  readonly listAgentInstances: (tabId: string | null) => Promise<readonly DesktopChannelAgentInstance[]>;
  readonly startAgentSession: (tabId: string | null, profileId: string) => Promise<DesktopRuntimeStatus>;
  readonly listAgentSessions: (
    tabId: string | null,
    agentInstanceId: string,
  ) => Promise<readonly DesktopChannelSession[]>;
  readonly getSession: (tabId: string | null, sessionId: string) => Promise<Session | null>;
  readonly selectSession: (
    tabId: string | null,
    sessionId: string,
  ) => Promise<{ runtimeStatus: DesktopRuntimeStatus; session: Session | null }>;
  readonly readSessionTaskStatus: (tabId: string | null, sessionId: string) => Promise<AgentTaskStatus | null>;
  readonly createSession: (
    tabId: string | null,
    title: string,
    agentInstanceId: string | null,
  ) => Promise<DesktopChannelSession>;
  /** Active tool-approval batch for the channel, or null (see bridge). */
  readonly pendingApproval?: () => ChannelApprovalPrompt | null;
  /** Answer the active tool-approval batch. */
  readonly respondApproval?: (
    decision: ChannelApprovalDecision,
    requestId?: string,
  ) => Promise<ChannelApprovalResult>;
}

interface ChannelControlSnapshot {
  readonly busy: boolean;
  readonly status: DesktopRuntimeStatus | null;
  readonly instances: readonly DesktopChannelAgentInstance[];
  readonly sessions: readonly DesktopChannelSession[];
  readonly taskStatuses: ReadonlyMap<string, AgentTaskStatus | null>;
}

const EMPTY_SNAPSHOT: ChannelControlSnapshot = {
  busy: false,
  status: null,
  instances: [],
  sessions: [],
  taskStatuses: new Map(),
};

function toAgentOption(
  instance: DesktopChannelAgentInstance,
  activeInstanceId: string | null,
): ChannelAgentOption {
  return {
    id: instance.id,
    profileId: instance.profileId,
    name: instance.profileName,
    isActive: activeInstanceId != null && instance.id === activeInstanceId,
  };
}

function toSessionOption(session: DesktopChannelSession): ChannelSessionOption {
  return {
    id: session.id,
    title: session.title,
    agentInstanceId: session.agentInstanceId ?? null,
    status: session.status,
    updatedAt: session.updatedAt,
  };
}

/** 1-based index, exact id, profileId, or (case-insensitive) display name. */
function resolveIndexed<T>(
  ref: string,
  items: readonly T[],
  keys: (item: T) => readonly string[],
): T | null {
  const byExact = items.find((item) => keys(item).includes(ref));
  if (byExact) {
    return byExact;
  }
  const position = Number.parseInt(ref, 10);
  if (Number.isInteger(position) && position >= 1 && position <= items.length) {
    return items[position - 1] ?? null;
  }
  const lowered = ref.trim().toLowerCase();
  return items.find((item) => keys(item).some((key) => key.toLowerCase() === lowered)) ?? null;
}

export function createDesktopChannelControl(deps: DesktopChannelControlDeps): ChannelControl {
  let snapshot: ChannelControlSnapshot = EMPTY_SNAPSHOT;

  const tabId = (): string | null => deps.getChannelTabId();
  const activeInstanceId = (): string | null => snapshot.status?.agentInstanceId ?? null;

  const rebuildSnapshot = async (): Promise<ChannelControlSnapshot> => {
    const targetTabId = tabId();
    const tabState = await deps.getTabState(targetTabId);
    const status = await deps.getRuntimeStatus(targetTabId);
    const instances = await deps.listAgentInstances(targetTabId);
    const instanceId = status.agentInstanceId ?? null;
    const sessions = instanceId ? await deps.listAgentSessions(targetTabId, instanceId) : [];
    const taskStatuses = new Map<string, AgentTaskStatus | null>();
    for (const session of sessions) {
      taskStatuses.set(session.id, await deps.readSessionTaskStatus(targetTabId, session.id));
    }
    return { busy: tabState.isSubmitting, status, instances, sessions, taskStatuses };
  };

  const refresh = async (): Promise<void> => {
    try {
      const next = await rebuildSnapshot();
      snapshot = next;
    } catch {
      // Keep the previous snapshot: a failing refresh must never break inbound
      // handling or drop a pending task.
    }
  };

  const activeSessionOption = async (): Promise<ChannelSessionOption | null> => {
    const sessionId = snapshot.status?.activeSessionId ?? null;
    if (!sessionId) {
      return null;
    }
    const cached = snapshot.sessions.find((session) => session.id === sessionId);
    if (cached) {
      return toSessionOption(cached);
    }
    try {
      const fetched = await deps.getSession(tabId(), sessionId);
      return fetched ? toSessionOption(fetched) : null;
    } catch {
      return null;
    }
  };

  return {
    refresh,
    isRuntimeBusy: () => snapshot.busy,

    listAgents: () =>
      snapshot.instances.map((instance) => toAgentOption(instance, activeInstanceId())),

    selectAgent: async (ref: string): Promise<ChannelAgentSelection> => {
      const instance = resolveIndexed(ref, snapshot.instances, (item) => [
        item.id,
        item.profileId,
        item.profileName,
      ]);
      let profileId = instance?.profileId ?? null;
      if (!profileId) {
        const profiles = await deps.listAgentProfiles();
        const profile = resolveIndexed(ref, profiles, (item) => [item.id, item.name]);
        profileId = profile?.id ?? null;
      }
      if (!profileId) {
        throw new Error(`Unknown agent "${ref}". Use /agents to list available agents.`);
      }
      await deps.startAgentSession(tabId(), profileId);
      await refresh();
      const activeId = activeInstanceId();
      const nextInstance =
        snapshot.instances.find((item) => item.id === activeId) ??
        snapshot.instances.find((item) => item.profileId === profileId) ??
        null;
      const agent: ChannelAgentOption = nextInstance
        ? toAgentOption(nextInstance, activeId)
        : { id: activeId ?? profileId, profileId, name: profileId, isActive: true };
      return { agent, session: await activeSessionOption() };
    },

    listSessions: (agentInstanceId?: string | null): ChannelSessionOption[] => {
      const wanted = agentInstanceId ?? activeInstanceId();
      const filtered = wanted
        ? snapshot.sessions.filter(
            (session) => (session.agentInstanceId ?? activeInstanceId()) === wanted,
          )
        : snapshot.sessions;
      const source = filtered.length > 0 ? filtered : snapshot.sessions;
      return source.map(toSessionOption);
    },

    createSession: async (title: string, agentInstanceId: string | null): Promise<ChannelSessionOption> => {
      const session = await deps.createSession(tabId(), title, agentInstanceId);
      await refresh();
      return toSessionOption(session);
    },

    selectSession: async (sessionId: string): Promise<ChannelSessionOption> => {
      const response = await deps.selectSession(tabId(), sessionId);
      if (!response.session) {
        throw new Error(`Unknown session "${sessionId}". Use /sessions to list available sessions.`);
      }
      await refresh();
      return toSessionOption(response.session);
    },

    getSessionStatus: (sessionId: string): ChannelSessionStatus => {
      const session = snapshot.sessions.find((item) => item.id === sessionId) ?? null;
      return {
        sessionId,
        title: session?.title ?? null,
        agentInstanceId: session?.agentInstanceId ?? activeInstanceId(),
        sessionStatus: session?.status ?? null,
        taskStatus: snapshot.taskStatuses.get(sessionId) ?? null,
        updatedAt: session?.updatedAt ?? null,
      };
    },

    reset: async (): Promise<void> => {
      await refresh();
    },

    // Approval surface is fully owned by the bridge (no snapshot needed).
    ...(deps.pendingApproval
      ? { pendingApproval: (): ChannelApprovalPrompt | null => deps.pendingApproval?.() ?? null }
      : {}),
    ...(deps.respondApproval
      ? {
          respondApproval: (decision: ChannelApprovalDecision, requestId?: string) =>
            deps.respondApproval!(decision, requestId),
        }
      : {}),
  };
}
