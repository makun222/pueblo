import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../shared/config';
import type { WorkflowStatus } from '../shared/schema';

export interface ResolvedWorkflowPlanPaths {
  readonly runtimePlanPath: string;
  readonly deliverablePlanPath: string | null;
}

export interface WorkflowDirectoryListingEntry {
  readonly workflowId: string;
  readonly path: string;
}

export interface OrphanedDirectoryEntry {
  readonly workflowId: string;
  readonly path: string;
  readonly knownToDatabase: boolean;
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

  resolveWorkflowDirectoryPath(workflowId: string): string {
    return path.resolve(this.config.workflow.runtimeDirectory, workflowId);
  }

  disposeWorkflow(workflowId: string, status: WorkflowStatus): void {
    const workflowDir = this.resolveWorkflowDirectoryPath(workflowId);
    if (!fs.existsSync(workflowDir)) {
      return;
    }

    if (status === 'completed') {
      return;
    }

    if (this.config.workflow.archiveOnFailure) {
      const archiveDir = path.resolve(this.config.workflow.runtimeDirectory, '_archive', workflowId);
      fs.mkdirSync(path.dirname(archiveDir), { recursive: true });
      moveDirectory(workflowDir, archiveDir);
      return;
    }

    fs.rmSync(workflowDir, { recursive: true, force: true });
  }

  listWorkflowDirectories(): WorkflowDirectoryListingEntry[] {
    const root = this.config.workflow.runtimeDirectory;
    if (!fs.existsSync(root)) {
      return [];
    }

    const entries: WorkflowDirectoryListingEntry[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (entry.name === '_archive') {
        continue;
      }

      const isUuid = /^[0-9a-fA-F-]{36}$/.test(entry.name);
      if (!isUuid) {
        continue;
      }

      entries.push({ workflowId: entry.name, path: path.resolve(root, entry.name) });
    }

    return entries;
  }

  removeWorkflowDirectory(workflowId: string): boolean {
    const workflowDir = this.resolveWorkflowDirectoryPath(workflowId);
    if (!fs.existsSync(workflowDir)) {
      return false;
    }

    fs.rmSync(workflowDir, { recursive: true, force: true });
    return true;
  }
}

function moveDirectory(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    fs.rmSync(destination, { recursive: true, force: true });
  }
  fs.renameSync(source, destination);
}

export function slugifyGoal(goal: string): string {
  const normalized = goal.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized.slice(0, 60) : 'workflow';
}

function normalizeMarkdown(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}
