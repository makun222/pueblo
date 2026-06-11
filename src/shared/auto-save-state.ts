/**
 * Session-level auto-save state (not persisted — Decision 1: A).
 *
 * When enabled, edit/write tools capture snapshots before directly writing
 * to target files, bypassing the shadow-edit review flow.
 */
let autoSaveEnabled = false;

export function isAutoSaveEnabled(): boolean {
  return autoSaveEnabled;
}

export function setAutoSaveEnabled(enabled: boolean): void {
  autoSaveEnabled = enabled;
}
