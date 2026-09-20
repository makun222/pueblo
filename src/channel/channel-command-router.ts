// ---------------------------------------------------------------------------
// Channel Command Router — "/" control commands sent from an IM channel.
//
// Channels are a *window* onto the CLI runtime. These commands let a user pick
// an agent instance + session and query execution status without going through
// the LLM. The router is intentionally dependency-free so it can be unit
// tested; it only talks to the host via the `ChannelControl` contract.
// ---------------------------------------------------------------------------

import type {
  ChannelAgentOption,
  ChannelApprovalDecision,
  ChannelApprovalPrompt,
  ChannelControl,
  ChannelSessionOption,
  ChannelSessionStatus,
} from './channel-types';

export interface ChannelCommandInvocation {
  command: string;
  args: string[];
  /** Raw argument text (everything after the command token) */
  rawArgs: string;
}

export interface ChannelBindingView {
  sessionId: string;
  agentInstanceId?: string | null;
  selectedSessionId?: string | null;
}

export interface ChannelCommandContext {
  binding: ChannelBindingView | null;
}

export interface ChannelSelectionUpdate {
  agentInstanceId?: string | null;
  selectedSessionId?: string | null;
}

export interface ChannelCommandOutcome {
  /** true when the text was a recognized command and must not reach the LLM */
  handled: boolean;
  reply: string | null;
  /** Non-undefined → host should persist this selection onto the conversation */
  selection?: ChannelSelectionUpdate;
  /** true → host should clear the conversation binding */
  reset?: boolean;
}

const PLAIN_TEXT: ChannelCommandOutcome = { handled: false, reply: null };

/**
 * Parse a "/" command. Returns null for plain text (including "//" escapes and
 * unknown commands) so those still flow to the LLM as before.
 */
export function parseChannelCommand(text: string): ChannelCommandInvocation | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }
  // "//..." escapes a leading slash → treat as plain text.
  if (trimmed.startsWith('//')) {
    return null;
  }
  const withoutSlash = trimmed.slice(1);
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(withoutSlash);
  if (!match) {
    return null;
  }
  const command = match[1].toLowerCase();
  const rawArgs = (match[2] ?? '').trim();
  return {
    command,
    args: rawArgs.length > 0 ? rawArgs.split(/\s+/) : [],
    rawArgs,
  };
}

const KNOWN_COMMANDS = new Set([
  'help',
  'agents',
  'agent',
  'sessions',
  'session',
  'new',
  'status',
  'current',
  'reset',
  'pending',
  'approve',
  'approve-all',
  'deny',
]);

/** Run a recognized channel command against the host control surface. */
export async function runChannelCommand(
  invocation: ChannelCommandInvocation,
  control: ChannelControl,
  context: ChannelCommandContext,
): Promise<ChannelCommandOutcome> {
  if (!KNOWN_COMMANDS.has(invocation.command)) {
    return PLAIN_TEXT;
  }

  switch (invocation.command) {
    case 'help':
      return { handled: true, reply: formatHelp() };
    case 'agents':
      return { handled: true, reply: formatAgentList(control.listAgents()) };
    case 'agent':
      return await runSelectAgent(invocation, control);
    case 'sessions':
      return runListSessions(invocation, control, context);
    case 'session':
      return await runSelectSession(invocation, control, context);
    case 'new':
      return await runNewSession(invocation, control, context);
    case 'status':
      return runStatus(invocation, control, context);
    case 'current':
      return { handled: true, reply: formatCurrent(control, context) };
    case 'reset':
      return { handled: true, reply: '♻️ 已清除该会话的 channel 绑定，下次对话回到默认 Agent。', reset: true };
    case 'pending':
      return runPendingApproval(control);
    case 'approve':
      return await runApprove(invocation, control);
    case 'approve-all':
      return await runRespondApprovalAll(control, 'allow-all', '✅ 已通过全部待审批请求。');
    case 'deny':
      return await runRespondApprovalAll(control, 'deny', '⛔ 已驳回全部待审批请求。');
    default:
      return PLAIN_TEXT;
  }
}

// ─── Command implementations ──────────────────────────────────────────────

async function runSelectAgent(
  invocation: ChannelCommandInvocation,
  control: ChannelControl,
): Promise<ChannelCommandOutcome> {
  const ref = resolveRef(invocation.rawArgs, control.listAgents(), (a) => [a.id, a.profileId, a.name]);
  if (!ref) {
    return { handled: true, reply: `${formatAgentList(control.listAgents())}\n\n用法：/agent <编号|实例id|Agent名称>` };
  }
  try {
    const selection = await control.selectAgent(ref);
    const session = selection.session;
    return {
      handled: true,
      reply: [
        `✅ 已切换到 Agent：${selection.agent.name}（${selection.agent.profileId}）`,
        session ? `📂 当前会话：${session.title}（${short(session.id)}）` : '📂 该 Agent 暂无会话，可用 /new <标题> 新建。',
      ].join('\n'),
      selection: {
        agentInstanceId: selection.agent.id,
        selectedSessionId: session?.id ?? null,
      },
    };
  } catch (error) {
    return { handled: true, reply: `⚠️ 切换 Agent 失败：${(error as Error).message}` };
  }
}

function runListSessions(
  invocation: ChannelCommandInvocation,
  control: ChannelControl,
  context: ChannelCommandContext,
): Promise<ChannelCommandOutcome> | ChannelCommandOutcome {
  const ref = invocation.rawArgs.trim();
  let agentInstanceId = context.binding?.agentInstanceId ?? null;
  if (ref) {
    const agents = control.listAgents();
    const resolved = resolveRef(ref, agents, (a) => [a.id, a.profileId, a.name]);
    if (!resolved) {
      return { handled: true, reply: `${formatAgentList(agents)}\n\n用法：/sessions [Agent编号]` };
    }
    agentInstanceId = resolved;
  }
  return { handled: true, reply: formatSessionList(control.listSessions(agentInstanceId), agentInstanceId) };
}

async function runSelectSession(
  invocation: ChannelCommandInvocation,
  control: ChannelControl,
  context: ChannelCommandContext,
): Promise<ChannelCommandOutcome> {
  const ref = invocation.rawArgs.trim();
  if (!ref) {
    return { handled: true, reply: `${formatSessionList(control.listSessions(context.binding?.agentInstanceId ?? null), context.binding?.agentInstanceId ?? null)}\n\n用法：/session <编号|会话id>` };
  }
  const sessions = control.listSessions(context.binding?.agentInstanceId ?? null);
  const resolved = resolveRef(ref, sessions, (s) => [s.id, s.title]);
  if (!resolved) {
    return { handled: true, reply: `${formatSessionList(sessions, context.binding?.agentInstanceId ?? null)}\n\n⚠️ 未找到会话「${ref}」。` };
  }
  try {
    const session = await control.selectSession(resolved);
    return {
      handled: true,
      reply: `✅ 当前会话：${session.title}（${short(session.id)}）`,
      selection: { selectedSessionId: session.id, agentInstanceId: session.agentInstanceId },
    };
  } catch (error) {
    return { handled: true, reply: `⚠️ 切换会话失败：${(error as Error).message}` };
  }
}

async function runNewSession(
  invocation: ChannelCommandInvocation,
  control: ChannelControl,
  context: ChannelCommandContext,
): Promise<ChannelCommandOutcome> {
  const agentInstanceId = context.binding?.agentInstanceId ?? null;
  const title = invocation.rawArgs.trim() || `Channel session ${new Date().toISOString().slice(0, 16)}`;
  try {
    const session = await control.createSession(title, agentInstanceId);
    return {
      handled: true,
      reply: `🆕 已新建会话：${session.title}（${short(session.id)}），直接发消息即可开始。`,
      selection: { selectedSessionId: session.id, agentInstanceId: session.agentInstanceId },
    };
  } catch (error) {
    return { handled: true, reply: `⚠️ 新建会话失败：${(error as Error).message}` };
  }
}

function runStatus(
  invocation: ChannelCommandInvocation,
  control: ChannelControl,
  context: ChannelCommandContext,
): ChannelCommandOutcome {
  const sessionId = invocation.rawArgs.trim() || context.binding?.selectedSessionId || context.binding?.sessionId;
  if (!sessionId) {
    return { handled: true, reply: '⚠️ 尚未绑定任何会话。用 /agents 选择 Agent，或 /new 新建会话。' };
  }
  const status = control.getSessionStatus(sessionId);
  return { handled: true, reply: formatStatus(status) };
}

// ─── Formatting ───────────────────────────────────────────────────────────

// ─── Approval implementations ─────────────────────────────────────────────

const NO_APPROVAL_SURFACE_REPLY = '⚠️ 当前宿主不支持审批命令，请在桌面端处理。';

function runPendingApproval(control: ChannelControl): ChannelCommandOutcome {
  if (!control.pendingApproval) {
    return { handled: true, reply: NO_APPROVAL_SURFACE_REPLY };
  }
  const prompt = control.pendingApproval();
  if (!prompt) {
    return { handled: true, reply: '✅ 当前没有待审批的工具调用。' };
  }
  return { handled: true, reply: formatApprovalPrompt(prompt) };
}

async function runApprove(
  invocation: ChannelCommandInvocation,
  control: ChannelControl,
): Promise<ChannelCommandOutcome> {
  if (!control.pendingApproval || !control.respondApproval) {
    return { handled: true, reply: NO_APPROVAL_SURFACE_REPLY };
  }
  const prompt = control.pendingApproval();
  if (!prompt) {
    return { handled: true, reply: '✅ 当前没有待审批的工具调用。' };
  }

  const raw = invocation.rawArgs.trim();
  if (!raw) {
    if (prompt.requests.length === 1) {
      return respondToApproval(control, 'allow', prompt.requests[0].id);
    }
    return {
      handled: true,
      reply: `有 ${prompt.requests.length} 项待审批，请用 /approve <序号>。\n\n${formatApprovalPrompt(prompt)}`,
    };
  }
  if (!/^\d+$/.test(raw)) {
    return { handled: true, reply: `⚠️ 序号无效：${raw}。用法：/approve <序号>` };
  }

  const index = Number.parseInt(raw, 10);
  const request = prompt.requests[index - 1];
  if (!request) {
    return { handled: true, reply: `⚠️ 序号超出范围（1-${prompt.requests.length}）。` };
  }

  const outcome = await respondToApproval(control, 'allow', request.id);
  const others = prompt.requests.length - 1;
  if (outcome.reply && others > 0) {
    return {
      handled: true,
      reply: `${outcome.reply}\n（其余 ${others} 项未选择，将一并被拒绝；如需全部通过请用 /approve-all）`,
    };
  }
  return outcome;
}

async function runRespondApprovalAll(
  control: ChannelControl,
  decision: ChannelApprovalDecision,
  successNote: string,
): Promise<ChannelCommandOutcome> {
  if (!control.pendingApproval || !control.respondApproval) {
    return { handled: true, reply: NO_APPROVAL_SURFACE_REPLY };
  }
  if (!control.pendingApproval()) {
    return { handled: true, reply: '✅ 当前没有待审批的工具调用。' };
  }
  return respondToApproval(control, decision, undefined, successNote);
}

async function respondToApproval(
  control: ChannelControl,
  decision: ChannelApprovalDecision,
  requestId?: string,
  successNote?: string,
): Promise<ChannelCommandOutcome> {
  if (!control.respondApproval) {
    return { handled: true, reply: NO_APPROVAL_SURFACE_REPLY };
  }
  try {
    const result = await control.respondApproval(decision, requestId);
    return { handled: true, reply: result.message || successNote || '✅ 已提交审批决定。' };
  } catch (error) {
    return {
      handled: true,
      reply: `⚠️ 审批失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Render a pending approval batch as an IM-friendly prompt. */
export function formatApprovalPrompt(prompt: ChannelApprovalPrompt): string {
  const lines = [
    `🔐 有 ${prompt.requests.length} 项工具调用待审批（批次 ${short(prompt.batchId)}）：`,
  ];
  prompt.requests.forEach((request, index) => {
    const label = request.title || request.summary || request.toolName;
    lines.push(`${index + 1}. [${request.kind}] ${label}`);
  });
  lines.push('');
  lines.push(`逐条通过：${prompt.requests.map((_, index) => `/approve ${index + 1}`).join(' · ')}`);
  lines.push('全部通过：/approve-all　·　全部驳回：/deny');
  return lines.join('\n');
}

export function formatHelp(): string {
  return [
    '🐦 Pueblo 飞书控制指令',
    '/agents              列出可选 Agent 实例',
    '/agent <编号|id|名称>  选择 Agent（不存在则创建）',
    '/sessions [Agent编号]  列出会话',
    '/session <编号|id>     选择会话',
    '/new [标题]           新建会话并选中',
    '/status [会话id]       查看执行情况（只读）',
    '/current              查看当前绑定',
    '/reset                清除绑定，回到默认 Agent',
    '/pending              查看待审批的工具调用',
    '/approve <序号>        通过第 N 项（其余将被拒绝）',
    '/approve-all          通过全部待审批项',
    '/deny                 驳回全部待审批项',
    '',
    '非命令文本会直接发给当前会话；以 // 开头表示字面文本。',
  ].join('\n');
}

export function formatAgentList(agents: ChannelAgentOption[]): string {
  if (agents.length === 0) {
    return '🤖 暂无 Agent 实例。';
  }
  const lines = agents.map((agent, index) => {
    const marker = agent.isActive ? ' ✅当前' : '';
    return `${index + 1}. ${agent.name}（${agent.profileId}）${short(agent.id)}${marker}`;
  });
  return ['🤖 可选 Agent 实例：', ...lines, '', '用 /agent <编号> 选择。'].join('\n');
}

export function formatSessionList(sessions: ChannelSessionOption[], agentInstanceId?: string | null): string {
  const header = agentInstanceId ? `📂 Agent ${short(agentInstanceId)} 的会话：` : '📂 会话列表：';
  if (sessions.length === 0) {
    return `${header}\n（暂无会话，用 /new <标题> 新建。）`;
  }
  const lines = sessions.map((session, index) => {
    const when = session.updatedAt ? session.updatedAt.replace('T', ' ').slice(0, 16) : '';
    return `${index + 1}. ${session.title} · ${session.status} · ${short(session.id)} · ${when}`;
  });
  return [header, ...lines, '', '用 /session <编号> 选择。'].join('\n');
}

export function formatStatus(status: ChannelSessionStatus): string {
  const icon: Record<string, string> = {
    pending: '⏳',
    running: '🏃',
    completed: '✅',
    failed: '❌',
  };
  const taskLabel = status.taskStatus
    ? `${icon[status.taskStatus] ?? ''}${status.taskStatus}`
    : '（暂无任务记录）';
  const lines = [
    `📊 会话 ${short(status.sessionId)}${status.title ? `「${status.title}」` : ''}`,
    `• 会话状态：${status.sessionStatus ?? 'unknown'}`,
    `• 任务状态：${taskLabel}`,
    `• 目标：${status.goal?.trim() || '—'}`,
    `• 最近输出：${status.outputSummary?.trim() || '—'}`,
    status.updatedAt ? `• 更新时间：${status.updatedAt.replace('T', ' ').slice(0, 19)}` : null,
  ].filter((line): line is string => line !== null);
  return lines.join('\n');
}

export function formatCurrent(control: ChannelControl, context: ChannelCommandContext): string {
  const binding = context.binding;
  if (!binding) {
    return '📍 当前未绑定。用 /agents 选择 Agent。';
  }
  const agent = control.listAgents().find((a) => a.id === binding.agentInstanceId);
  const sessionId = binding.selectedSessionId || binding.sessionId;
  return [
    '📍 当前绑定：',
    `• Agent：${agent ? `${agent.name}（${agent.profileId}）` : binding.agentInstanceId ?? '默认'}`,
    `• 会话：${sessionId ? short(sessionId) : '—'}`,
  ].join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function short(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Resolve a reference to an id. Accepts a 1-based index into `items`, an exact
 * id, or a case-insensitive match against any of the item's aliases.
 */
export function resolveRef<T>(
  ref: string,
  items: T[],
  aliases: (item: T) => string[],
): string | null {
  const trimmed = ref.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10) - 1;
    const item = items[index];
    if (!item) {
      return null;
    }
    const [first] = aliases(item);
    return first ?? null;
  }
  const lowered = trimmed.toLowerCase();
  const exact = items.find((item) => aliases(item).some((alias) => alias.toLowerCase() === lowered));
  if (exact) {
    const [first] = aliases(exact);
    return first ?? null;
  }

  // Loose match: IM users often type "code-master" / "Code Master" for the
  // "code master" profile alias, so compare with separators and case removed.
  // Only accept an unambiguous match to avoid binding to the wrong agent.
  const normalized = normalizeRef(trimmed);
  if (normalized) {
    const loose = items.filter((item) => aliases(item).some((alias) => normalizeRef(alias) === normalized));
    if (loose.length === 1) {
      const [first] = aliases(loose[0]);
      return first ?? null;
    }
  }
  return trimmed;
}

/** Lowercase + strip separators so "CODE-MASTER" and "Code Master" compare equal. */
function normalizeRef(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}
