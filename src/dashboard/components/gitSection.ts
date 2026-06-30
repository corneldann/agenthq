// components/gitSection.ts — git status display + confirm modal + commit-state machine
// Feature: monitor-dashboard-redesign
// Implements Requirements 6.8, 6.9, 6.10, 6.11, 6.12, 6.13
// Layout: two-column card — Build (left) | Commit (right)

import { el } from '../utils.js';
import { getState, setState, subscribe } from '../state.js';
import type { GitStatus, AppState } from '../types.js';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Root card element — created once, never re-created. */
let _root: HTMLElement | null = null;

/** Left column element — created once, holds Build button + output. */
let _buildColEl: HTMLElement | null = null;

/** Right column element — created once, content updated via innerHTML on rerender. */
let _commitColEl: HTMLElement | null = null;

/** Unsubscribe function from the AppState subscriber. */
let _unsub: (() => void) | null = null;

/** jobStem returned by POST /git-commit — used to track the commit job. */
let _jobStem: string | null = null;

/** Auto-reset timer handle for the commit 'done' state. */
let _resetTimer: ReturnType<typeof setTimeout> | null = null;

/** Live output poll interval — only active while commitState === 'running'. */
let _livePoller: ReturnType<typeof setInterval> | null = null;

/** Persistent <pre> element for live commit output — survives rerender() calls. */
let _liveOutputEl: HTMLPreElement | null = null;

/** Build status panel element — shows stale/up-to-date info above the Build button. */
let _buildStatusEl: HTMLElement | null = null;

/** Build status poll interval — runs every 5s when not building. */
let _buildStatusPoller: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Build section — module-level state
// ---------------------------------------------------------------------------

type BuildState = 'idle' | 'running' | 'done' | 'error';

let _buildState: BuildState = 'idle';
let _buildOutputEl: HTMLPreElement | null = null;
let _buildBtnEl: HTMLButtonElement | null = null;
let _buildEs: EventSource | null = null;
let _buildResetTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Build helpers — stopBuildStream, startBuild
// ---------------------------------------------------------------------------

function stopBuildStream(): void {
  if (_buildEs !== null) {
    _buildEs.close();
    _buildEs = null;
  }
}

function startBuild(): void {
  if (_buildState === 'running') return;
  stopBuildStream();
  stopBuildStatusPoller();  // pause status polling while building

  _buildState = 'running';
  if (_buildStatusEl) {
    _buildStatusEl.innerHTML = `<span style="color:var(--muted);font-size:11px">Building…</span>`;
  }
  if (_buildBtnEl) {
    _buildBtnEl.textContent = '⏳ Building…';
    _buildBtnEl.disabled = true;
  }
  if (_buildOutputEl) {
    _buildOutputEl.style.display = 'block';
    _buildOutputEl.textContent = '';
  }

  const es = new EventSource('/build-stream');
  _buildEs = es;

  es.onmessage = (ev: MessageEvent) => {
    let line: string;
    try { line = JSON.parse(ev.data) as string; } catch { line = ev.data as string; }

    if (line.startsWith('__EXIT__:')) {
      const code = parseInt(line.slice(9), 10);
      _buildState = code === 0 ? 'done' : 'error';
      stopBuildStream();
      if (_buildBtnEl) {
        _buildBtnEl.textContent = code === 0 ? '✓ Built' : '✖ Build failed';
        _buildBtnEl.disabled = false;
        _buildBtnEl.style.borderColor = code === 0 ? 'var(--green)' : 'var(--red)';
        _buildBtnEl.style.color = code === 0 ? 'var(--green)' : 'var(--red)';
        _buildBtnEl.style.background = 'transparent';
      }
      // Refresh build status now that dist has been updated
      void refreshBuildStatus();
      if (_buildResetTimer) clearTimeout(_buildResetTimer);
      _buildResetTimer = setTimeout(() => {
        _buildState = 'idle';
        if (_buildBtnEl) {
          _buildBtnEl.textContent = 'Build';
          _buildBtnEl.disabled = false;
          _buildBtnEl.style.borderColor = '';
          _buildBtnEl.style.color = '';
          _buildBtnEl.style.background = '';
        }
        if (_buildOutputEl) _buildOutputEl.style.display = 'none';
        startBuildStatusPoller();
      }, 8_000);
      return;
    }

    if (_buildOutputEl) {
      _buildOutputEl.textContent += ((_buildOutputEl.textContent ?? '').length > 0 ? '\n' : '') + line;
      _buildOutputEl.scrollTop = _buildOutputEl.scrollHeight;
    }
  };

  es.onerror = () => {
    if (_buildState !== 'running') return;
    _buildState = 'error';
    stopBuildStream();
    if (_buildBtnEl) {
      _buildBtnEl.textContent = '✖ Build failed';
      _buildBtnEl.disabled = false;
    }
  };
}

/** Fetch /build-status and update _buildStatusEl imperatively. */
async function refreshBuildStatus(): Promise<void> {
  if (_buildStatusEl === null || _buildState === 'running') return;
  try {
    const res = await fetch('/build-status');
    if (!res.ok) return;
    const data = await res.json() as { stale: boolean; staleFiles: string[]; distBuiltAt: string | null; error?: string };
    if (data.error) return;

    if (!data.stale) {
      _buildStatusEl.innerHTML = `<span style="color:var(--green);font-size:11px">✓ Up to date${data.distBuiltAt ? ' · ' + data.distBuiltAt : ''}</span>`;
    } else {
      const count = data.staleFiles.length;
      const rows = data.staleFiles.slice(0, 6).map(f =>
        `<div style="color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">· ${escapeHtml(f)}</div>`
      ).join('');
      const more = count > 6 ? `<div style="color:var(--muted);font-size:11px">· +${count - 6} more</div>` : '';
      _buildStatusEl.innerHTML =
        `<span style="color:var(--amber);font-size:11px;font-weight:600">⚠ ${count} file${count !== 1 ? 's' : ''} changed — rebuild needed</span>` +
        `<div style="margin-top:4px">${rows}${more}</div>`;
    }
  } catch { /* network blip */ }
}

function startBuildStatusPoller(): void {
  if (_buildStatusPoller !== null) return;
  void refreshBuildStatus();
  _buildStatusPoller = setInterval(() => { void refreshBuildStatus(); }, 5000);
}

function stopBuildStatusPoller(): void {
  if (_buildStatusPoller !== null) {
    clearInterval(_buildStatusPoller);
    _buildStatusPoller = null;
  }
}

// ---------------------------------------------------------------------------
// Build column — rendered once, elements stored in module vars
// ---------------------------------------------------------------------------

/** Create the persistent Build column (left side). Called once by renderGitSection(). */
function createBuildColumn(): HTMLElement {
  const col = el('div', { class: 'chain-card__left' });

  // Status panel — shows stale/up-to-date info above the button
  const statusEl = document.createElement('div');
  statusEl.style.cssText = 'margin-bottom:6px;min-height:16px';
  statusEl.innerHTML = `<span style="color:var(--muted);font-size:11px">Checking…</span>`;
  _buildStatusEl = statusEl;

  // Build button — matches chain-card__btn style
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Build';
  btn.className = 'chain-card__btn';
  btn.style.cssText = 'align-self:flex-start;font-size:13px;padding:5px 12px';
  _buildBtnEl = btn;
  btn.addEventListener('click', () => startBuild());

  // Live output <pre>
  const pre = document.createElement('pre');
  pre.style.cssText = [
    'display:none',
    'margin:6px 0 0',
    'padding:8px 10px',
    'background:var(--bg)',
    'border:1px solid var(--border)',
    'border-radius:4px',
    'font-size:11px',
    'line-height:1.5',
    'color:var(--muted)',
    'white-space:pre-wrap',
    'word-break:break-all',
    'max-height:200px',
    'overflow-y:auto',
    'font-family:ui-monospace,SFMono-Regular,Consolas,monospace',
  ].join(';');
  _buildOutputEl = pre;

  col.appendChild(statusEl);
  col.appendChild(btn);
  col.appendChild(pre);
  return col;
}

// ---------------------------------------------------------------------------
// File list row helpers
// ---------------------------------------------------------------------------

function flagLabel(flag: string): string {
  switch (flag) {
    case 'M': return 'M';
    case 'A': return 'A';
    case 'D': return 'D';
    case 'R': return 'R';
    case '?': return '?';
    default:  return flag;
  }
}

function buildFileRows(gitStatus: GitStatus): HTMLElement[] {
  const rows: HTMLElement[] = [];

  const addRows = (files: string[], flag: string): void => {
    for (const path of files) {
      const badge = el('span', { class: 'git-section__flag git-section__flag--' + flag.toLowerCase() }, [
        flagLabel(flag),
      ]);
      const pathEl = el('span', { class: 'git-section__filepath' }, [path]);
      rows.push(el('div', { class: 'git-section__file-row' }, [badge, pathEl]));
    }
  };

  addRows(gitStatus.staged, 'S');
  addRows(gitStatus.modified, 'M');
  addRows(gitStatus.untracked, 'U');

  return rows;
}

// ---------------------------------------------------------------------------
// Modal — confirm before committing (Requirement 6.13)
// ---------------------------------------------------------------------------

function showConfirmModal(gitStatus: GitStatus): void {
  const overlay = el('div', {
    class: 'git-section__modal-overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Confirm commit',
  });
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'background:rgba(0,0,0,0.6)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'z-index:1000',
  ].join(';');

  const panel = el('div', { class: 'git-section__modal-panel' });
  panel.style.cssText = [
    'background:#1e1e2e',
    'border:1px solid #3f3f5e',
    'border-radius:8px',
    'padding:20px 24px',
    'min-width:340px',
    'max-width:480px',
    'color:#cdd6f4',
    'font-family:ui-monospace,SFMono-Regular,Consolas,monospace',
    'font-size:13px',
  ].join(';');

  const title = el('h3', { class: 'git-section__modal-title' }, ['Confirm Commit & Push']);
  title.style.cssText = 'margin:0 0 12px;font-size:15px;color:#cba6f7';

  const subtitle = el('p', { class: 'git-section__modal-subtitle' }, [
    'The following files will be committed:',
  ]);
  subtitle.style.cssText = 'margin:0 0 10px;color:#a6adc8';

  const fileList = el('div', { class: 'git-section__modal-files' });
  fileList.style.cssText = [
    'max-height:200px',
    'overflow-y:auto',
    'margin-bottom:16px',
    'border:1px solid #313244',
    'border-radius:4px',
    'padding:8px',
    'background:#181825',
  ].join(';');

  buildFileRows(gitStatus).forEach((row) => fileList.appendChild(row));

  const btnRow = el('div', { class: 'git-section__modal-buttons' });
  btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';

  const cancelBtn = el('button', { type: 'button', class: 'git-section__btn git-section__btn--cancel' }, [
    'Cancel',
  ]);
  cancelBtn.style.cssText = [
    'padding:6px 14px',
    'border-radius:4px',
    'border:1px solid #45475a',
    'background:#313244',
    'color:#cdd6f4',
    'cursor:pointer',
    'font-family:inherit',
    'font-size:13px',
  ].join(';');

  const confirmBtn = el('button', { type: 'button', class: 'git-section__btn git-section__btn--confirm' }, [
    'Commit & Push',
  ]);
  confirmBtn.style.cssText = [
    'padding:6px 14px',
    'border-radius:4px',
    'border:1px solid #89b4fa',
    'background:#1e66f5',
    'color:#fff',
    'cursor:pointer',
    'font-family:inherit',
    'font-size:13px',
  ].join(';');

  const dismiss = (): void => {
    overlay.remove();
    setState({ commitState: null });
  };

  cancelBtn.addEventListener('click', dismiss);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss();
  });

  confirmBtn.addEventListener('click', async () => {
    overlay.remove();
    await triggerCommit();
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(confirmBtn);
  panel.appendChild(title);
  panel.appendChild(subtitle);
  panel.appendChild(fileList);
  panel.appendChild(btnRow);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Commit trigger — POST /git-commit (Requirement 6.10)
// ---------------------------------------------------------------------------

async function triggerCommit(): Promise<void> {
  try {
    const response = await fetch('/git-commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
      console.error('[gitSection] POST /git-commit failed:', body.error);
      setState({ commitState: 'error' });
      return;
    }

    const result = await response.json() as { jobStem?: string };
    _jobStem = result.jobStem ?? null;
    setState({ commitState: 'running' });
  } catch (err) {
    console.error('[gitSection] POST /git-commit network error:', err);
    setState({ commitState: 'error' });
  }
}

// ---------------------------------------------------------------------------
// Job tracking — watch AppState.jobs for the commit job (Req 6.10–6.12)
// ---------------------------------------------------------------------------

function findCommitJob(state: AppState): { status: string; id: string; logFile: string } | null {
  if (_jobStem === null) return null;
  const stem = _jobStem;
  for (const job of state.jobs) {
    if (job.id === stem || job.jobChain.includes(stem) || job.name.includes(stem)) {
      return { status: job.status, id: job.id, logFile: job.logFile };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Live output poller
// ---------------------------------------------------------------------------

function startLivePoller(jobId: string): void {
  if (_livePoller !== null) return;
  _livePoller = setInterval(async () => {
    try {
      const res = await fetch(`/view/${encodeURIComponent(jobId)}`);
      if (!res.ok) return;
      const text = await res.text();
      if (_liveOutputEl === null) return;
      const sepIdx = text.indexOf('\n---\n');
      const body = sepIdx >= 0 ? text.slice(sepIdx + 5) : text;
      const lines = body.split('\n').filter(l => l.trim().length > 0);
      const tail = lines.slice(-30).join('\n');
      _liveOutputEl.textContent = tail || 'Waiting for output…';
      _liveOutputEl.scrollTop = _liveOutputEl.scrollHeight;
    } catch { /* network blip — ignore */ }
  }, 1500);
}

function stopLivePoller(): void {
  if (_livePoller !== null) {
    clearInterval(_livePoller);
    _livePoller = null;
  }
  _liveOutputEl = null;
}

// ---------------------------------------------------------------------------
// Commit column content builder — single function replacing all state variants
// (The _liveOutputEl <pre> node is appended imperatively in rerenderCommitCol
//  when in 'running' state — it cannot be serialised to innerHTML.)
// ---------------------------------------------------------------------------

/**
 * Build the full HTML for the commit column.
 * Renders an action row (based on commitState / dirty status) and a history
 * list of recent file-edit jobs from AppState.
 */
function buildCommitColHtml(
  commitState: import('../types.js').CommitState,
  gitStatus: GitStatus | null,
  commitJobs: import('../types.js').Job[],
  logFile?: string | null,
): string {
  // --- Action row ---
  let actionHtml = '';

  if (commitState === 'running') {
    actionHtml = `<div style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text)">` +
      `<span aria-hidden="true">⏳</span><span>Generating commit message…</span>` +
      `</div>`;
  } else if (commitState === 'done') {
    actionHtml = `<span style="color:var(--green);font-size:13px">✓ pushed</span>`;
  } else if (commitState === 'error') {
    const link = (logFile != null && logFile !== '')
      ? ` <a href="/view/${encodeURIComponent(logFile)}" style="color:var(--red);text-decoration:underline;font-size:13px;margin-left:8px">View log →</a>`
      : '';
    actionHtml = `<div style="display:flex;align-items:center">` +
      `<span style="color:var(--red);font-size:13px">✖ Commit failed</span>${link}` +
      `</div>`;
  } else if (gitStatus === null) {
    actionHtml = `<span style="color:var(--muted);font-size:13px">Loading git status…</span>`;
  } else if (!gitStatus.clean) {
    // Dirty — show Commit & Push button + collapsed file list
    const btnCls = 'chain-card__btn';
    const btnStyle = 'font-size:13px;padding:5px 12px;align-self:flex-start';

    // Collapse noisy file groups
    const allFiles = [...gitStatus.staged, ...gitStatus.modified, ...gitStatus.untracked];
    const sessionFiles = allFiles.filter(f => f.includes('.kiro/sessions/') || f.includes('.kiro\\sessions\\'));
    const promptOutputFiles = allFiles.filter(f => f.includes('prompts/output/') || f.includes('prompts\\output\\'));
    const otherFiles = allFiles.filter(f =>
      !f.includes('.kiro/sessions/') && !f.includes('.kiro\\sessions\\') &&
      !f.includes('prompts/output/') && !f.includes('prompts\\output\\')
    );

    const rowStyle = 'display:flex;align-items:center;padding:2px 0;font-size:12px;color:var(--muted)';
    const badgeBase = 'display:inline-block;padding:0 4px;border-radius:3px;font-size:10px;margin-right:6px;color:var(--bg)';

    let fileRowsHtml = '';
    for (const f of otherFiles) {
      const flag = gitStatus.staged.includes(f) ? 'S' : gitStatus.modified.includes(f) ? 'M' : 'U';
      const bg = flag === 'S' ? 'var(--green)' : flag === 'M' ? 'var(--amber)' : 'var(--accent)';
      fileRowsHtml += `<div style="${rowStyle}">` +
        `<span style="${badgeBase};background:${bg}">${flag}</span>` +
        `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)">${escapeHtml(f)}</span>` +
        `</div>`;
    }
    if (sessionFiles.length > 0) {
      fileRowsHtml += `<div style="${rowStyle}"><span style="margin-right:6px">◦</span>` +
        `${sessionFiles.length} session state file${sessionFiles.length !== 1 ? 's' : ''}</div>`;
    }
    if (promptOutputFiles.length > 0) {
      fileRowsHtml += `<div style="${rowStyle}"><span style="margin-right:6px">◦</span>` +
        `${promptOutputFiles.length} prompt output file${promptOutputFiles.length !== 1 ? 's' : ''}</div>`;
    }

    actionHtml = `<button type="button" data-action="commit" class="${btnCls}" style="${btnStyle}">Commit &amp; Push</button>` +
      `<div style="margin-top:6px">${fileRowsHtml}</div>`;
  } else if (commitJobs.length === 0) {
    actionHtml = `<span style="color:var(--muted);font-style:italic;font-size:13px">✓ Nothing to commit</span>`;
  }
  // else: clean with history — no action row needed, just show history below

  // --- History list ---
  let historyHtml = '';
  if (commitJobs.length > 0) {
    const rowStyle = 'display:flex;justify-content:space-between;font-size:12px;color:var(--muted);padding:3px 0';
    const rows = commitJobs.map(job => {
      const dot = job.status === 'done' || job.status === 'reported'
        ? `<span style="margin-right:6px;color:var(--green)">●</span>`
        : job.status === 'error'
          ? `<span style="margin-right:6px;color:var(--red)">●</span>`
          : `<span style="margin-right:6px;color:var(--muted)">○</span>`;
      const msg = escapeHtml((job.lastLine ?? '').slice(0, 60));
      const ts = escapeHtml(job.timestamp);
      return `<div style="${rowStyle}">` +
        `<span style="display:flex;align-items:center;min-width:0;overflow:hidden">${dot}` +
        `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)">${msg}</span></span>` +
        `<span style="flex-shrink:0;margin-left:12px;color:var(--muted)">${ts}</span>` +
        `</div>`;
    });
    historyHtml = `<div style="margin-top:${actionHtml ? '8px' : '0'}">${rows.join('')}</div>`;
  }

  return actionHtml + historyHtml;
}

// ---------------------------------------------------------------------------
// HTML escape helper
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// State machine advancement
// ---------------------------------------------------------------------------

function advanceCommitState(state: AppState): void {
  if (state.commitState !== 'running') return;

  const job = findCommitJob(state);
  if (job === null) return;

  if (job.status === 'done') {
    stopLivePoller();
    setState({ commitState: 'done' });
    if (_resetTimer !== null) clearTimeout(_resetTimer);
    _resetTimer = setTimeout(() => {
      _jobStem = null;
      _resetTimer = null;
      setState({ commitState: null });
    }, 30_000);
  } else if (job.status === 'error') {
    stopLivePoller();
    setState({ commitState: 'error' });
  }
}

// ---------------------------------------------------------------------------
// Commit column re-render — updates _commitColEl content only
// ---------------------------------------------------------------------------

function rerenderCommitCol(): void {
  if (_commitColEl === null) return;

  const state = getState();

  // Advance state machine before deciding what to render
  advanceCommitState(state);

  // Re-read after possible advancement
  const { gitStatus, commitState, jobs } = getState();

  // Build commit job history from AppState (last 8 file-edit jobs, newest first)
  const commitJobs = jobs
    .filter(j => j.type === 'file-edit')
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 8);

  let needLivePre = false;
  let jobId: string | null = null;

  if (commitState === 'running') {
    needLivePre = true;
    const job = findCommitJob(getState());
    jobId = job?.id ?? null;
    if (_livePoller === null && jobId !== null) {
      startLivePoller(jobId);
    }
  }

  const logFile = commitState === 'error' ? (findCommitJob(getState())?.logFile ?? null) : null;

  _commitColEl.innerHTML = buildCommitColHtml(commitState, gitStatus, commitJobs, logFile);

  // Wire up the Commit & Push button if present (dirty state)
  const btn = _commitColEl.querySelector('[data-action="commit"]') as HTMLButtonElement | null;
  if (btn !== null) {
    btn.addEventListener('click', () => void triggerCommit());
  }

  // Append the persistent live output <pre> in running state
  if (needLivePre) {
    if (_liveOutputEl === null) {
      _liveOutputEl = document.createElement('pre');
      _liveOutputEl.style.cssText = [
        'margin:0',
        'padding:8px 10px',
        'background:var(--bg)',
        'border:1px solid var(--border)',
        'border-radius:4px',
        'font-size:11px',
        'line-height:1.5',
        'color:var(--muted)',
        'white-space:pre-wrap',
        'word-break:break-all',
        'max-height:200px',
        'overflow-y:auto',
        'font-family:ui-monospace,SFMono-Regular,Consolas,monospace',
      ].join(';');
      _liveOutputEl.textContent = 'Waiting for output…';
    }
    _commitColEl.appendChild(_liveOutputEl);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * renderGitSection — creates the two-column card layout once and returns it.
 * Subsequent calls return the same root element (idempotent) and refresh content.
 *
 * Layout: single dark card with two equal columns separated by a 1px divider.
 *   Left  = Build column (persistent button + output <pre>)
 *   Right = Commit column (innerHTML updated on each state change)
 *
 * Requirements 6.8–6.13
 */
export function renderGitSection(): HTMLElement {
  if (_root !== null) {
    rerenderCommitCol();
    return _root;
  }

  // Outer card — uses chain-card CSS class for visual consistency
  _root = el('div', { class: 'chain-card', 'data-component': 'git-section' });
  _root.style.cssText = 'margin-bottom:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace';

  // Left column — Build (chain-card__left)
  _buildColEl = createBuildColumn();
  _buildColEl.className = 'chain-card__left';

  // Right column — Commit (chain-card__right)
  _commitColEl = el('div', { class: 'chain-card__right' });
  _commitColEl.style.cssText = 'display:flex;flex-direction:column;gap:6px';

  _root.appendChild(_buildColEl);
  _root.appendChild(_commitColEl);

  // Initial commit column render
  rerenderCommitCol();

  // Start build status poller
  startBuildStatusPoller();

  // Subscribe to AppState changes — only update commit column
  _unsub = subscribe(() => rerenderCommitCol());

  return _root;
}

/**
 * destroyGitSection — teardown for tests or hot-reload.
 * Stops all pollers, closes EventSource, clears timers, nulls all refs.
 */
export function destroyGitSection(): void {
  if (_unsub !== null) {
    _unsub();
    _unsub = null;
  }
  if (_resetTimer !== null) {
    clearTimeout(_resetTimer);
    _resetTimer = null;
  }
  if (_buildResetTimer !== null) {
    clearTimeout(_buildResetTimer);
    _buildResetTimer = null;
  }
  stopBuildStream();
  stopBuildStatusPoller();
  stopLivePoller();
  _buildBtnEl = null;
  _buildOutputEl = null;
  _buildStatusEl = null;
  _buildColEl = null;
  _commitColEl = null;
  _root = null;
  _jobStem = null;
}

/**
 * getJobStem — exposed for testing; returns the current tracked jobStem.
 */
export function getJobStem(): string | null {
  return _jobStem;
}
