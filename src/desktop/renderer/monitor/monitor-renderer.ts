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
  content?: string;
  finalOutput?: string;
}

interface Window {
  monitorAPI: {
    onJobProgress: (cb: (data: JobProgressData) => void) => () => void;
    onJobComplete: (cb: (data: { jobId: string }) => void) => () => void;
    onJobError: (cb: (data: { jobId: string; error: string }) => void) => () => void;
    getActiveJobs: () => Promise<unknown>;
    cancelJob: (jobId: string) => Promise<unknown>;
  };
}

const jobCards = new Map<string, HTMLElement>();
const outputsByJob = new Map<string, string[]>();

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
      <div class="job-output"></div>
      <button class="cancel-btn" data-job-id="${escapeHtml(data.jobId)}">Cancel</button>
    `;
    const cancelBtn = card.querySelector('.cancel-btn') as HTMLButtonElement;
    cancelBtn.addEventListener('click', () => {
      cancelBtn.disabled = true;
      window.monitorAPI.cancelJob(data.jobId).catch(() => {
        cancelBtn.disabled = false;
      });
    });
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

  // Render accumulated output content
  const outputEl = card.querySelector('.job-output') as HTMLElement;
  if (outputEl) {
    if (data.status === 'completed' && data.finalOutput) {
      outputEl.innerHTML = `<div class="final-output">${escapeHtml(data.finalOutput)}</div>`;
      outputEl.style.display = 'block';
    } else {
      const outputs = outputsByJob.get(data.jobId);
      if (outputs && outputs.length > 0) {
        outputEl.innerHTML = outputs
          .map((o, i) => `<div class="round-output">Round ${i + 1}: ${escapeHtml(o)}</div>`)
          .join('');
        outputEl.style.display = 'block';
      } else {
        outputEl.style.display = 'none';
      }
    }
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Register IPC listeners from main process
window.monitorAPI.onJobProgress((data: JobProgressData) => {
  // Accumulate per-round content for output display
  if (data.content) {
    let outputs = outputsByJob.get(data.jobId);
    if (!outputs) {
      outputs = [];
      outputsByJob.set(data.jobId, outputs);
    }
    outputs.push(data.content);
  }
  renderJobCard(data);
});

function disableCancelButton(jobId: string): void {
  const card = jobCards.get(jobId);
  if (card) {
    const btn = card.querySelector('.cancel-btn') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
  }
}

window.monitorAPI.onJobComplete((data: { jobId: string }) => {
  const card = jobCards.get(data.jobId);
  if (card) {
    const statusEl = card.querySelector('.job-status')!;
    statusEl.textContent = '✓ Completed';
    statusEl.className = 'job-status completed';
    disableCancelButton(data.jobId);
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
    disableCancelButton(data.jobId);
  }
});
