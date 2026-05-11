import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowExporter } from '../../src/workflow/workflow-exporter';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('workflow exporter', () => {
  it('exports the runtime plan to the deliverable path when no file exists yet', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-exporter-'));
    tempDirs.push(tempDir);
    const runtimePlanPath = path.join(tempDir, '.plans', 'workflow-1', 'feature.plan.md');
    const deliverablePlanPath = path.join(tempDir, 'app', 'feature.plan.md');
    fs.mkdirSync(path.dirname(runtimePlanPath), { recursive: true });
    fs.writeFileSync(runtimePlanPath, '# Plan: feature', 'utf8');

    const result = new WorkflowExporter().exportPlan({
      runtimePlanPath,
      deliverablePlanPath,
    });

    expect(result.status).toBe('exported');
    expect(fs.readFileSync(deliverablePlanPath, 'utf8')).toBe('# Plan: feature\n');
  });

  it('reports a conflict and leaves the existing deliverable untouched when contents differ', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-exporter-'));
    tempDirs.push(tempDir);
    const runtimePlanPath = path.join(tempDir, '.plans', 'workflow-1', 'feature.plan.md');
    const deliverablePlanPath = path.join(tempDir, 'app', 'feature.plan.md');
    fs.mkdirSync(path.dirname(runtimePlanPath), { recursive: true });
    fs.mkdirSync(path.dirname(deliverablePlanPath), { recursive: true });
    fs.writeFileSync(runtimePlanPath, '# Plan: new content\n', 'utf8');
    fs.writeFileSync(deliverablePlanPath, '# Plan: old content\n', 'utf8');

    const result = new WorkflowExporter().exportPlan({
      runtimePlanPath,
      deliverablePlanPath,
    });

    expect(result.status).toBe('conflict');
    expect(result.exportedAt).toBeNull();
    expect(fs.readFileSync(deliverablePlanPath, 'utf8')).toBe('# Plan: old content\n');
  });
});