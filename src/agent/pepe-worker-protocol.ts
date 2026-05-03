import type { AppConfig } from '../shared/config';
import type { MemoryRecord } from '../shared/schema';

export interface PepeWorkerSessionSnapshot {
  readonly sessionId: string;
  readonly selectedMemoryIds: string[];
  readonly pendingInput?: string;
  readonly memories: MemoryRecord[];
}

export interface PepeWorkerSummary {
  readonly parentMemoryId: string;
  readonly summary: string;
}

export interface PepeWorkerResultCandidate {
  readonly memoryId: string | null;
  readonly parentMemoryId: string | null;
  readonly summary: string;
  readonly similarity: number;
  readonly sourceSessionId: string | null;
  readonly vectorVersion: string;
}

export interface PepeWorkerProcessResult {
  readonly sessionId: string;
  readonly summaries: PepeWorkerSummary[];
  readonly resultCandidates: PepeWorkerResultCandidate[];
  readonly lastSummaryAt: string | null;
  readonly lastSummaryMemoryId: string | null;
}

export interface PepeWorkerData {
  readonly config: AppConfig;
}

export type PepeWorkerRequest = {
  readonly type: 'process-session';
  readonly requestId: string;
  readonly snapshot: PepeWorkerSessionSnapshot;
} | {
  readonly type: 'shutdown';
};

export type PepeWorkerResponse = {
  readonly type: 'process-result';
  readonly requestId: string;
  readonly result: PepeWorkerProcessResult;
} | {
  readonly type: 'process-error';
  readonly requestId: string;
  readonly errorMessage: string;
};