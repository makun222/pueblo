import type { AgentProfileTemplate, PuebloProfile } from '../shared/schema';

export function mergeAgentTemplateWithPuebloProfile(template: AgentProfileTemplate | null, workspaceProfile: PuebloProfile): PuebloProfile {
  if (!template) {
    return workspaceProfile;
  }

  return {
    roleDirectives: [...template.roleDirectives, ...workspaceProfile.roleDirectives],
    goalDirectives: [...template.goalDirectives, ...workspaceProfile.goalDirectives],
    constraintDirectives: [...template.constraintDirectives, ...workspaceProfile.constraintDirectives],
    styleDirectives: [...template.styleDirectives, ...workspaceProfile.styleDirectives],
    memoryPolicy: {
      retentionHints: [...template.memoryPolicy.retentionHints, ...workspaceProfile.memoryPolicy.retentionHints],
      summaryHints: [...template.memoryPolicy.summaryHints, ...workspaceProfile.memoryPolicy.summaryHints],
    },
    contextPolicy: {
      priorityHints: [...template.contextPolicy.priorityHints, ...workspaceProfile.contextPolicy.priorityHints],
      truncationHints: [...template.contextPolicy.truncationHints, ...workspaceProfile.contextPolicy.truncationHints],
    },
    summaryPolicy: {
      autoSummarize: template.summaryPolicy.autoSummarize && workspaceProfile.summaryPolicy.autoSummarize,
      thresholdHint: workspaceProfile.summaryPolicy.thresholdHint ?? template.summaryPolicy.thresholdHint,
      lineageHint: workspaceProfile.summaryPolicy.lineageHint ?? template.summaryPolicy.lineageHint,
    },
    loadedFromPath: workspaceProfile.loadedFromPath,
    loadedAt: workspaceProfile.loadedAt,
  };
}