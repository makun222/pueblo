import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Worker, type MessagePort } from 'node:worker_threads';
import type { AppConfig, PepeConfig } from '../shared/config';
import type { BackgroundSummaryStatus } from '../shared/schema';
import type { AgentInstanceService } from './agent-instance-service';
import { PepeMemoryMirror } from './pepe-memory-mirror';
import { PepeResultService } from './pepe-result-service';
import type { MemoryService } from '../memory/memory-service';
import type { SessionService } from '../sessions/session-service';
import type {
  PepeWorkerData,
  PepeWorkerResultCandidate,
  PepeWorkerProcessResult,
  PepeWorkerRequest,
  PepeWorkerResponse,
  PepeWorkerSessionSnapshot,
} from './pepe-worker-protocol';
import { toPepeResultItem } from './pepe-result-ranking';

interface PepeSessionMonitor {
  readonly sessionId: string;
  readonly agentInstanceId: string;
  readonly intervalId: NodeJS.Timeout;
  lastInput: string | null;
  lastSummaryAt: string | null;
  lastSummaryMemoryId: string | null;
}

interface PendingWorkerRequest {
  readonly resolve: (result: PepeWorkerProcessResult) => void;
  readonly reject: (error: Error) => void;
}

export interface PepeWorkerLike {
  postMessage(message: PepeWorkerRequest): void;
  on(event: 'message', listener: (message: PepeWorkerResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  terminate(): Promise<number>;
}

export type PepeWorkerFactory = (data: PepeWorkerData) => PepeWorkerLike;

export interface PepeSupervisorDependencies {
  readonly appConfig: AppConfig;
  readonly config: Pick<PepeConfig, 'enabled' | 'flushIntervalMs' | 'workingDirectoryPattern'>;
  readonly memoryService: Pick<MemoryService, 'listSessionMemories' | 'createDerivedSummaryMemory'>;
  readonly sessionService: Pick<SessionService, 'getSession' | 'addSelectedMemory'>;
  readonly agentInstanceService: Pick<AgentInstanceService, 'getAgentInstance'>;
  readonly resultService: PepeResultService;
  readonly memoryMirror?: PepeMemoryMirror;
  readonly workerFactory?: PepeWorkerFactory;
}

export class PepeSupervisor {
  private readonly monitors = new Map<string, PepeSessionMonitor>();
  private readonly pendingWorkerRequests = new Map<string, PendingWorkerRequest>();
  private readonly memoryMirror: PepeMemoryMirror;
  private readonly worker: PepeWorkerLike | null;

  constructor(private readonly dependencies: PepeSupervisorDependencies) {
    this.memoryMirror = dependencies.memoryMirror ?? new PepeMemoryMirror(dependencies.config);
    this.worker = dependencies.config.enabled
      ? (dependencies.workerFactory ?? createPepeWorker)({ config: dependencies.appConfig })
      : null;
    this.worker?.on('message', (message) => {
      this.handleWorkerMessage(message);
    });
    this.worker?.on('error', (error) => {
      this.handleWorkerError(error);
    });
  }

  startSession(sessionId: string | null | undefined): void {
    if (!this.dependencies.config.enabled || !sessionId || this.monitors.has(sessionId)) {
      return;
    }

    const session = this.dependencies.sessionService.getSession(sessionId);
    if (!session?.agentInstanceId) {
      return;
    }

    const agentInstance = this.dependencies.agentInstanceService.getAgentInstance(session.agentInstanceId);
    if (!agentInstance) {
      return;
    }

    const intervalId = setInterval(() => {
      void this.flushSession(sessionId);
    }, this.dependencies.config.flushIntervalMs);

    this.monitors.set(sessionId, {
      sessionId,
      agentInstanceId: agentInstance.id,
      intervalId,
      lastInput: null,
      lastSummaryAt: null,
      lastSummaryMemoryId: null,
    });

    void this.flushSession(sessionId);
  }

  recordInput(sessionId: string | null | undefined, input: string): void {
    if (!sessionId) {
      return;
    }

    const monitor = this.monitors.get(sessionId);
    if (monitor) {
      monitor.lastInput = input;
      return;
    }

    this.startSession(sessionId);
    const startedMonitor = this.monitors.get(sessionId);
    if (startedMonitor) {
      startedMonitor.lastInput = input;
    }
  }

  async flushSession(sessionId: string | null | undefined): Promise<void> {
    if (!this.dependencies.config.enabled || !sessionId) {
      return;
    }

    const monitor = this.monitors.get(sessionId);
    const session = this.dependencies.sessionService.getSession(sessionId);
    if (!monitor || !session?.agentInstanceId) {
      return;
    }

    const agentInstance = this.dependencies.agentInstanceService.getAgentInstance(session.agentInstanceId);
    if (!agentInstance) {
      return;
    }

    let memories = this.dependencies.memoryService.listSessionMemories(sessionId);
    const workerResult = await this.processSnapshotInWorker({
      sessionId,
      selectedMemoryIds: session.selectedMemoryIds,
      pendingInput: monitor.lastInput ?? undefined,
      memories,
    });
    memories = this.applyWorkerSummaries(sessionId, memories, workerResult);

    const refreshedSession = this.dependencies.sessionService.getSession(sessionId);
    const summaryMemoryIdsByParent = buildSummaryMemoryMap(memories);
    const resolvedResultItems = resolveWorkerResultItems(workerResult?.resultCandidates ?? [], summaryMemoryIdsByParent);
    this.dependencies.resultService.cacheSessionResult({
      sessionId,
      agentInstanceId: agentInstance.id,
      selectedMemoryIds: refreshedSession?.selectedMemoryIds ?? session.selectedMemoryIds,
      pendingUserInput: monitor.lastInput ?? undefined,
      resultItems: resolvedResultItems,
    });
    const resolvedResult = this.dependencies.resultService.resolve({
      sessionId,
      agentInstanceId: agentInstance.id,
      selectedMemoryIds: refreshedSession?.selectedMemoryIds ?? session.selectedMemoryIds,
      pendingUserInput: monitor.lastInput ?? undefined,
    });

    this.memoryMirror.flush({
      agentInstanceId: agentInstance.id,
      workspaceRoot: agentInstance.workspaceRoot,
      sessionId,
      memories,
      resultSet: resolvedResult.resultSet,
    });

    monitor.lastSummaryAt = workerResult?.lastSummaryAt ?? new Date().toISOString();
    monitor.lastSummaryMemoryId = workerResult?.lastSummaryMemoryId
      ?? memories.at(-1)?.id
      ?? resolvedResult.resultItems.at(0)?.memoryId
      ?? null;
  }

  getBackgroundSummaryStatus(sessionId: string | null | undefined): BackgroundSummaryStatus {
    const monitor = sessionId ? this.monitors.get(sessionId) : null;

    if (!monitor) {
      return {
        state: 'idle',
        activeSummarySessionId: null,
        lastSummaryAt: null,
        lastSummaryMemoryId: null,
      };
    }

    return {
      state: 'running',
      activeSummarySessionId: monitor.sessionId,
      lastSummaryAt: monitor.lastSummaryAt,
      lastSummaryMemoryId: monitor.lastSummaryMemoryId,
    };
  }

  stopSession(sessionId: string | null | undefined): void {
    if (!sessionId) {
      return;
    }

    const monitor = this.monitors.get(sessionId);
    if (!monitor) {
      return;
    }

    void this.flushSession(sessionId);
    clearInterval(monitor.intervalId);
    this.monitors.delete(sessionId);
  }

  stopAll(): void {
    for (const sessionId of [...this.monitors.keys()]) {
      this.stopSession(sessionId);
    }

    this.worker?.postMessage({ type: 'shutdown' });
    void this.worker?.terminate();
  }

  private async processSnapshotInWorker(snapshot: PepeWorkerSessionSnapshot): Promise<PepeWorkerProcessResult | null> {
    if (!this.worker) {
      return null;
    }

    const requestId = randomUUID();
    const request: PepeWorkerRequest = {
      type: 'process-session',
      requestId,
      snapshot,
    };

    return await new Promise<PepeWorkerProcessResult>((resolve, reject) => {
      this.pendingWorkerRequests.set(requestId, { resolve, reject });
      this.worker?.postMessage(request);
    });
  }

  private applyWorkerSummaries(
    sessionId: string,
    memories: Awaited<ReturnType<MemoryService['listSessionMemories']>>,
    result: PepeWorkerProcessResult | null,
  ) {
    if (!result || result.summaries.length === 0) {
      return memories;
    }

    const nextMemories = [...memories];
    const existingSummaryParents = new Set(buildSummaryMemoryMap(memories).keys());

    for (const summary of result.summaries) {
      if (existingSummaryParents.has(summary.parentMemoryId)) {
        continue;
      }

      const parentMemory = memories.find((candidate) => candidate.id === summary.parentMemoryId);
      if (!parentMemory) {
        continue;
      }

      const summaryMemory = this.dependencies.memoryService.createDerivedSummaryMemory({
        sessionId,
        parentMemory,
        summary: summary.summary,
      });
      this.dependencies.sessionService.addSelectedMemory(sessionId, summaryMemory.id);
      existingSummaryParents.add(parentMemory.id);
      nextMemories.push(summaryMemory);
    }

    return nextMemories;
  }

  private handleWorkerMessage(message: PepeWorkerResponse): void {
    const pending = this.pendingWorkerRequests.get(message.requestId);
    if (!pending) {
      return;
    }

    this.pendingWorkerRequests.delete(message.requestId);
    if (message.type === 'process-error') {
      pending.reject(new Error(message.errorMessage));
      return;
    }

    pending.resolve(message.result);
  }

  private handleWorkerError(error: Error): void {
    for (const [requestId, pending] of this.pendingWorkerRequests) {
      this.pendingWorkerRequests.delete(requestId);
      pending.reject(error);
    }
  }
}

function createPepeWorker(data: PepeWorkerData): PepeWorkerLike {
  return new Worker(resolvePepeWorkerPath(), {
    workerData: data,
  });
}

function resolvePepeWorkerPath(): string {
  return path.resolve(__dirname, 'pepe-worker.js');
}

function buildSummaryMemoryMap(memories: Awaited<ReturnType<MemoryService['listSessionMemories']>>): Map<string, string> {
  return new Map(
    memories
      .filter((memory) => memory.tags.includes('pepe-summary') && memory.parentId)
      .map((memory) => [memory.parentId!, memory.id] as const),
  );
}

function resolveWorkerResultItems(
  candidates: PepeWorkerResultCandidate[],
  summaryMemoryIdsByParent: Map<string, string>,
) {
  return candidates.flatMap((candidate) => {
    const resolvedMemoryId = candidate.memoryId
      ?? (candidate.parentMemoryId ? summaryMemoryIdsByParent.get(candidate.parentMemoryId) : null);

    if (!resolvedMemoryId) {
      return [];
    }

    return [toPepeResultItem(candidate, resolvedMemoryId)];
  });
}