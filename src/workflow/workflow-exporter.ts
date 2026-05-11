import fs from 'node:fs';
import path from 'node:path';

export interface WorkflowExportResult {
  readonly status: 'exported' | 'unchanged' | 'conflict';
  readonly deliverablePlanPath: string;
  readonly exportedAt: string | null;
}

export class WorkflowExporter {
  exportPlan(args: {
    readonly runtimePlanPath: string;
    readonly deliverablePlanPath: string;
  }): WorkflowExportResult {
    const content = normalizePlanContent(fs.readFileSync(args.runtimePlanPath, 'utf8'));

    if (fs.existsSync(args.deliverablePlanPath)) {
      const existingContent = normalizePlanContent(fs.readFileSync(args.deliverablePlanPath, 'utf8'));
      if (existingContent === content) {
        return {
          status: 'unchanged',
          deliverablePlanPath: args.deliverablePlanPath,
          exportedAt: null,
        };
      }

      return {
        status: 'conflict',
        deliverablePlanPath: args.deliverablePlanPath,
        exportedAt: null,
      };
    }

    fs.mkdirSync(path.dirname(args.deliverablePlanPath), { recursive: true });
    fs.writeFileSync(args.deliverablePlanPath, content, 'utf8');

    return {
      status: 'exported',
      deliverablePlanPath: args.deliverablePlanPath,
      exportedAt: new Date().toISOString(),
    };
  }
}

function normalizePlanContent(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}
