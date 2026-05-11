export interface PuebloPlanOutlineTask {
  readonly id: string;
  readonly title: string;
  readonly parentId: string | null;
}

export interface PuebloPlanOutline {
  readonly constraints: string[];
  readonly acceptanceCriteria: string[];
  readonly tasks: PuebloPlanOutlineTask[];
}

export function createInitialPuebloPlanOutline(args: { readonly goal: string }): PuebloPlanOutline {
  const normalizedGoal = args.goal.trim();

  return {
    constraints: [
      'Keep changes scoped to the requested goal.',
      'Prefer verifiable progress at the end of each round.',
      'Do not export the final plan deliverable until the workflow is complete.',
    ],
    acceptanceCriteria: [
      `The requested goal is completed: ${normalizedGoal}.`,
      'The implementation is validated with the narrowest available check.',
      'The runtime plan stays synchronized with execution status.',
    ],
    tasks: [
      { id: 'task-root', title: `Complete goal: ${normalizedGoal}`, parentId: null },
      { id: 'task-inspect', title: 'Inspect the current implementation surface and confirm the controlling code path.', parentId: 'task-root' },
      { id: 'task-plan', title: 'Refine the implementation approach for the next smallest executable slice.', parentId: 'task-root' },
      { id: 'task-implement', title: 'Implement the current highest-value slice with minimal related changes.', parentId: 'task-root' },
      { id: 'task-validate', title: 'Run focused validation for the current slice and capture results.', parentId: 'task-root' },
      { id: 'task-sync', title: 'Update runtime workflow state and prepare the next round or final export.', parentId: 'task-root' },
    ],
  };
}
