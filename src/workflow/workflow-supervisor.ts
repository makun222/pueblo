import type { AppConfig } from '../shared/config';
import type { WorkflowService } from './workflow-service';
import type { WorkflowTaskOutcome } from './workflow-fsm';

export interface WorkflowSupervisorOptions {
  readonly config: Pick<AppConfig, 'workflow'>;
  readonly workflowService: WorkflowService;
  readonly sweepIntervalMs?: number;
  readonly onTransition?: (entry: { workflowId: string; toStatus: string; reason: string | null }) => void;
}

export class WorkflowSupervisor {
  private readonly sweepIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(private readonly options: WorkflowSupervisorOptions) {
    this.sweepIntervalMs = options.sweepIntervalMs ?? Math.min(
      options.config.workflow.roundTimeoutMs,
      options.config.workflow.blockedTimeoutMs,
      options.config.workflow.pauseTimeoutMs,
    );
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.timer = setInterval(() => {
      this.sweep().catch(() => {
        // Watchdog failures must never crash the host process.
      });
    }, this.sweepIntervalMs);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  async sweep(): Promise<void> {
    const results = this.options.workflowService.runWatchdogSweep();
    for (const result of results) {
      this.options.onTransition?.({
        workflowId: result.workflow.id,
        toStatus: result.workflow.status,
        reason: null,
      });
    }
  }

  isRunning(): boolean {
    return this.started;
  }

  observeTaskOutcome(sessionId: string, outcome: WorkflowTaskOutcome): void {
    const activeWorkflow = this.options.workflowService.getActiveWorkflowForSession(sessionId);
    if (!activeWorkflow) {
      return;
    }

    const result = this.options.workflowService.observeTaskOutcome(activeWorkflow.id, outcome);
    if (result) {
      this.options.onTransition?.({
        workflowId: result.workflow.id,
        toStatus: result.workflow.status,
        reason: null,
      });
    }
  }
}
