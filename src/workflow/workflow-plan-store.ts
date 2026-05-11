import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../shared/config';

export interface ResolvedWorkflowPlanPaths {
  readonly runtimePlanPath: string;
  readonly deliverablePlanPath: string | null;
}

export class WorkflowPlanStore {
  constructor(private readonly config: Pick<AppConfig, 'workflow'>) {}

  resolvePaths(args: {
    readonly workflowId: string;
    readonly goal: string;
    readonly targetDirectory?: string | null;
  }): ResolvedWorkflowPlanPaths {
    const slug = slugifyGoal(args.goal);
    const runtimePlanPath = path.resolve(this.config.workflow.runtimeDirectory, args.workflowId, `${slug}.plan.md`);
    const deliverablePlanPath = args.targetDirectory
      ? path.resolve(
        args.targetDirectory,
        this.config.workflow.deliverableFilePattern.replace('{slug}', slug),
      )
      : null;

    return {
      runtimePlanPath,
      deliverablePlanPath,
    };
  }

  writePlan(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, normalizeMarkdown(content), 'utf8');
  }

  readPlan(filePath: string): string | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return fs.readFileSync(filePath, 'utf8');
  }

  hasPlan(filePath: string): boolean {
    return fs.existsSync(filePath);
  }
}

export function slugifyGoal(goal: string): string {
  const normalized = goal.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized.slice(0, 60) : 'workflow';
}

function normalizeMarkdown(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}
