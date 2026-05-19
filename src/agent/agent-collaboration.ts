import { randomUUID } from 'node:crypto';
import type {
  CollaborationCompletionCriteria,
  CollaborationGraph,
  CollaborationInstance,
  CollaborationRound,
  CollaborationRoundStatus,
  CollaborationStatus,
  NodeRoundResult,
  NodeRoundResultStatus,
} from '../shared/schema';
import type { AgentTask } from '../shared/schema';
import type { AgentTaskRunner, RunAgentTaskInput } from './task-runner';
import type { TaskContext } from './task-context';

// ── Store ────────────────────────────────────────────────────────

export interface AgentCollaborationStore {
  save(instance: CollaborationInstance): void;
  get(id: string): CollaborationInstance | null;
  delete(id: string): void;
  list(): CollaborationInstance[];
}

export class InMemoryAgentCollaborationStore implements AgentCollaborationStore {
  private readonly instances = new Map<string, CollaborationInstance>();

  save(instance: CollaborationInstance): void {
    this.instances.set(instance.id, instance);
  }

  get(id: string): CollaborationInstance | null {
    return this.instances.get(id) ?? null;
  }

  delete(id: string): void {
    this.instances.delete(id);
  }

  list(): CollaborationInstance[] {
    return Array.from(this.instances.values());
  }
}

// ── Inputs ───────────────────────────────────────────────────────

export interface StartCollaborationInput {
  readonly graph: CollaborationGraph;
  readonly goal: string;
  readonly completionCriteria: CollaborationCompletionCriteria;
  readonly sessionId?: string | null;
  readonly taskContext?: TaskContext;
}

// ── Service ──────────────────────────────────────────────────────

export interface AgentCollaborationDependencies {
  readonly store: AgentCollaborationStore;
  readonly taskRunner: AgentTaskRunner;
}

export class AgentCollaborationService {
  constructor(private readonly deps: AgentCollaborationDependencies) {}

  startCollaboration(input: StartCollaborationInput): CollaborationInstance {
    const now = new Date().toISOString();
    const firstNode = input.graph.nodes[0];
    const instance: CollaborationInstance = {
      id: randomUUID(),
      graph: input.graph,
      goal: input.goal,
      completionCriteria: input.completionCriteria,
      status: 'running',
      rounds: [],
      currentNodeId: firstNode?.nodeId ?? null,
      sessionId: input.sessionId ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      failedAt: null,
    };
    this.deps.store.save(instance);
    return instance;
  }

  /**
   * Execute one full round: run each node in topological order.
   * In P0 (linear A→B), this means run Node A, then Node B.
   */
  async executeNextRound(instanceId: string): Promise<CollaborationRound> {
    const instance = this.loadOrThrow(instanceId);
    this.ensureRunning(instance);

    const roundNumber = instance.rounds.length + 1;
    const now = new Date().toISOString();

    const round: CollaborationRound = {
      roundNumber,
      nodeResults: [],
      status: 'in-progress',
      startedAt: now,
      completedAt: null,
    };

    // Sort nodes in topological order (P0: linear chain A→B)
    const sortedNodeIds = this.topologicalSort(instance.graph);
    const previousResults = new Map<string, NodeRoundResult>();

    for (const nodeId of sortedNodeIds) {
      const node = instance.graph.nodes.find((n) => n.nodeId === nodeId);
      if (!node) continue;

      const nodeResult = await this.executeNode({
        node,
        goal: instance.goal,
        sessionId: instance.sessionId,
        previousResults,
        roundNumber,
      });

      round.nodeResults.push(nodeResult);
      previousResults.set(nodeId, nodeResult);

      if (nodeResult.status === 'failed') {
        // Mark round as failed and propagate
        round.status = 'failed';
        round.completedAt = new Date().toISOString();
        instance.rounds.push(round);
        instance.status = 'failed';
        instance.failedAt = round.completedAt;
        instance.updatedAt = round.completedAt;
        this.deps.store.save(instance);
        return round;
      }
    }

    round.status = 'completed';
    round.completedAt = new Date().toISOString();
    instance.rounds.push(round);

    // Evaluate completion
    if (this.evaluateCompletion(instance)) {
      instance.status = 'completed';
      instance.completedAt = round.completedAt;
    }

    instance.currentNodeId = sortedNodeIds[0] ?? null;
    instance.updatedAt = round.completedAt;
    this.deps.store.save(instance);

    return round;
  }

  getStatus(instanceId: string): {
    id: string;
    status: CollaborationStatus;
    goal: string;
    totalRounds: number;
    currentNodeId: string | null;
    lastRoundStatus: CollaborationRoundStatus | null;
  } {
    const instance = this.loadOrThrow(instanceId);
    const lastRound = instance.rounds.length > 0
      ? instance.rounds[instance.rounds.length - 1]
      : null;

    return {
      id: instance.id,
      status: instance.status,
      goal: instance.goal,
      totalRounds: instance.rounds.length,
      currentNodeId: instance.currentNodeId,
      lastRoundStatus: lastRound?.status ?? null,
    };
  }

  getInstance(instanceId: string): CollaborationInstance {
    return this.loadOrThrow(instanceId);
  }

  // ── Completion Evaluation ────────────────────────────────────

  evaluateCompletion(instance: CollaborationInstance): boolean {
    const criteria = instance.completionCriteria;

    switch (criteria.type) {
      case 'maxRounds':
        return (criteria.maxRounds ?? 1) <= instance.rounds.length;

      case 'agentApproval': {
        const approvalNodeId = criteria.approvalNodeId;
        if (!approvalNodeId) return false;
        const lastRound = instance.rounds[instance.rounds.length - 1];
        if (!lastRound) return false;
        const result = lastRound.nodeResults.find(
          (r) => r.nodeId === approvalNodeId,
        );
        if (!result || !result.outputSummary) return false;
        return result.outputSummary.includes('APPROVED');
      }

      case 'noChanges': {
        const threshold = criteria.noChangesRounds ?? 2;
        if (instance.rounds.length < threshold) return false;
        // Check if last N rounds had no substantial output change
        const recent = instance.rounds.slice(-threshold);
        const summaries = recent
          .flatMap((r) => r.nodeResults.map((n) => n.outputSummary))
          .filter(Boolean);
        const uniqueSummaries = new Set(summaries);
        return uniqueSummaries.size < recent.length;
      }

      case 'fixedOutput':
        // P0: fixedOutput type requires file system check — deferred to P1
        return false;

      default:
        return false;
    }
  }

  // ── Internal Methods ─────────────────────────────────────────

  private async executeNode(params: {
    node: CollaborationInstance['graph']['nodes'][number];
    goal: string;
    sessionId: string | null;
    previousResults: Map<string, NodeRoundResult>;
    roundNumber: number;
  }): Promise<NodeRoundResult> {
    const { node, goal, sessionId, previousResults, roundNumber } = params;
    const now = new Date().toISOString();

    // Build context from previous node outputs
    let inputContext = `Goal: ${goal}\nRound: ${roundNumber}\n`;
    if (previousResults.size > 0) {
      inputContext += '\n--- Output from previous nodes ---\n';
      for (const [prevNodeId, prevResult] of previousResults) {
        if (prevResult.outputSummary) {
          inputContext += `[${prevResult.nodeId}] ${prevResult.outputSummary}\n`;
        }
      }
    }

    const taskInput: RunAgentTaskInput = {
      goal,
      sessionId,
      providerId: node.providerId,
      modelId: node.modelId,
      inputContextSummary: inputContext,
    };

    try {
      const task: AgentTask = await this.deps.taskRunner.run(taskInput);

      const nodeStatus: NodeRoundResultStatus =
        task.status === 'completed' ? 'succeeded' : 'failed';

      return {
        nodeId: node.nodeId,
        agentProfileId: node.agentProfileId,
        status: nodeStatus,
        outputSummary: task.outputSummary ?? null,
        taskId: task.id,
        startedAt: now,
        completedAt: task.completedAt ?? now,
      };
    } catch (err) {
      return {
        nodeId: node.nodeId,
        agentProfileId: node.agentProfileId,
        status: 'failed',
        outputSummary: String(err),
        taskId: null,
        startedAt: now,
        completedAt: new Date().toISOString(),
      };
    }
  }

  private topologicalSort(graph: CollaborationGraph): string[] {
    // P0: assume linear chain (edges define order). Just follow the chain
    // from the source node (node with no incoming edge) to the sink.
    const inDegree = new Map<string, number>();
    const outEdges = new Map<string, string[]>();

    for (const node of graph.nodes) {
      inDegree.set(node.nodeId, 0);
      outEdges.set(node.nodeId, []);
    }

    for (const edge of graph.edges) {
      inDegree.set(edge.targetNodeId, (inDegree.get(edge.targetNodeId) ?? 0) + 1);
      const existing = outEdges.get(edge.sourceNodeId) ?? [];
      existing.push(edge.targetNodeId);
      outEdges.set(edge.sourceNodeId, existing);
    }

    // Find source
    const source = graph.nodes.find((n) => (inDegree.get(n.nodeId) ?? 0) === 0);
    if (!source) {
      // Fall back to array order
      return graph.nodes.map((n) => n.nodeId);
    }

    const order: string[] = [];
    const visited = new Set<string>();
    const queue = [source.nodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      order.push(current);

      for (const next of outEdges.get(current) ?? []) {
        if (!visited.has(next)) {
          queue.push(next);
        }
      }
    }

    return order;
  }

  private loadOrThrow(id: string): CollaborationInstance {
    const instance = this.deps.store.get(id);
    if (!instance) {
      throw new Error(`Collaboration instance not found: ${id}`);
    }
    return instance;
  }

  private ensureRunning(instance: CollaborationInstance): void {
    if (instance.status !== 'running') {
      throw new Error(
        `Collaboration instance ${instance.id} is ${instance.status}, expected running`,
      );
    }
  }
}
