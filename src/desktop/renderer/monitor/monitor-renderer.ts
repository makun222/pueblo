/**
 * Monitor renderer script — runs inside the Loop Monitor BrowserWindow.
 * Listens for loop job events via the preload bridge and updates the DOM.
 *
 * Phase 2 skeleton; full UI will be fleshed out in later phases.
 */

interface JobProgressData {
  jobId: string;
  status: 'running' | 'completed' | 'error';
  round?: number;
  totalRounds?: number;
  message?: string;
  error?: string;
}

declare global {
  interface Window {
    monitorAPI: {
      onJobProgress: (cb: (data: JobProgressData) => void) => () => void;
      onJobComplete: (cb: (data: { jobId: string }) => void) => () => void;
      onJobError: (cb: (data: { jobId: string; error: string }) => void) => () => void;
      getActiveJobs: () => Promise<unknown>;
    };
  }
}

const jobCards = new Map<string, HTMLElement>();

function getJobListElement(): HTMLElement {
  const el = document.getElementById('jobList');
  if (!el) throw new Error('Missing #jobList element');
  return el;
}

function clearEmptyState(): void {
  const empty = document.querySelector('.empty-state');
  if (empty) empty.remove();
}

function renderJobCard(data: JobProgressData): void {
  clearEmptyState();
  const jobList = getJobListElement();

  let card = jobCards.get(data.jobId);
  if (!card) {
    card = document.createElement('div');
    card.className = 'job-card';
    card.innerHTML = `
      <div class="job-id">${escapeHtml(data.jobId)}</div>
      <div class="job-status"></div>
      <div class="job-progress"></div>
    `;
    jobList.appendChild(card);
    jobCards.set(data.jobId, card);
  }

  const statusEl = card.querySelector('.job-status')!;
  statusEl.textContent = data.status === 'running' ? '● Running' :
    data.status === 'completed' ? '✓ Completed' :
    data.status === 'error' ? '✗ Error' : data.status;
  statusEl.className = `job-status ${data.status}`;

  const progressEl = card.querySelector('.job-progress')!;
  if (data.round != null && data.totalRounds != null) {
    progressEl.textContent = `Round ${data.round}/${data.totalRounds}${data.message ? ' - ' + data.message : ''}`;
  } else if (data.message) {
    progressEl.textContent = data.message;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Register IPC listeners from main process
window.monitorAPI.onJobProgress((data: JobProgressData) => {
  renderJobCard(data);
});

window.monitorAPI.onJobComplete((data: { jobId: string }) => {
  const card = jobCards.get(data.jobId);
  if (card) {
    const statusEl = card.querySelector('.job-status')!;
    statusEl.textContent = '✓ Completed';
    statusEl.className = 'job-status completed';
  }
});

window.monitorAPI.onJobError((data: { jobId: string; error: string }) => {
  const card = jobCards.get(data.jobId);
  if (card) {
    const statusEl = card.querySelector('.job-status')!;
    statusEl.textContent = '✗ Error';
    statusEl.className = 'job-status error';
    const progressEl = card.querySelector('.job-progress')! as HTMLElement;
    progressEl.textContent = data.error;
  }
});
