// pages/analytics.ts — Analytics dashboard page
// Phase 5.3 Analytics Layer
// Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6

import { el, esc } from '../utils.js';
import { getState, setState, getSelectedWorkspaceId } from '../state.js';
import { getPerformanceMetrics, getCostMetrics, getBottlenecks } from '../api.js';
import { renderBarChart } from '../components/barChart.js';
import { renderLineChart } from '../components/lineChart.js';
import type { AnalyticsRange } from '../types.js';
import type { PerformanceMetrics } from '../../analytics/metrics.js';
import type { CostMetrics } from '../../analytics/cost.js';
import type { BottleneckAnalysis } from '../../analytics/bottleneck.js';

// ---------------------------------------------------------------------------
// Module-level WebSocket/SSE metric-update listener teardown
// Stored so we can remove it when navigating away (prevent double-registration)
// ---------------------------------------------------------------------------

let _metricUpdateListener: ((e: Event) => void) | null = null;

// ---------------------------------------------------------------------------
// renderAnalyticsPage — pure shell HTML (AC 6.1)
// Returns static HTML that loadAnalytics() fills in.
// Uses esc() for any dynamic values inserted into the template.
// ---------------------------------------------------------------------------

/**
 * Returns the shell HTML structure for the Analytics page.
 * No data fetching occurs here — call loadAnalytics() after mounting.
 *
 * The time-range picker buttons carry `data-range` attributes so that
 * event delegation in initAnalyticsPage() can pick them up without querying
 * individual elements by id.
 *
 * Requirements: 6.1, 6.4
 */
export function renderAnalyticsPage(): string {
  return `
<div class="analytics-page" id="analytics-root">
  <div class="analytics-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
    <h1 style="margin:0;font-size:18px;font-weight:600;color:var(--md-on-surf,#cdd6f4)">Analytics</h1>
    <div class="analytics-time-range" id="analytics-range-picker" style="display:flex;gap:6px">
      <button class="analytics-range-btn" data-range="24h"
        style="padding:4px 12px;border:1px solid var(--md-outline,#6c7086);background:none;color:var(--md-on-surf-var,#a6adc8);border-radius:4px;cursor:pointer;font-size:12px">
        24h
      </button>
      <button class="analytics-range-btn analytics-range-btn--active" data-range="7d"
        style="padding:4px 12px;border:1px solid var(--md-primary,#89b4fa);background:var(--md-primary-c,#89b4fa22);color:var(--md-primary,#89b4fa);border-radius:4px;cursor:pointer;font-size:12px">
        7d
      </button>
      <button class="analytics-range-btn" data-range="30d"
        style="padding:4px 12px;border:1px solid var(--md-outline,#6c7086);background:none;color:var(--md-on-surf-var,#a6adc8);border-radius:4px;cursor:pointer;font-size:12px">
        30d
      </button>
    </div>
  </div>

  <div id="analytics-loading" style="display:none;color:var(--md-on-surf-var,#a6adc8);font-size:13px;margin-bottom:12px;padding:8px 0">
    Loading analytics…
  </div>

  <div class="analytics-metrics-grid"
    style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:20px">
    <div id="analytics-perf-card" class="analytics-card"
      style="background:var(--md-surf-low,#1e2030);border:1px solid var(--md-outline,#6c7086);border-radius:8px;padding:14px">
      <div class="analytics-card__title" style="font-size:12px;color:var(--md-on-surf-var,#a6adc8);margin-bottom:8px;font-weight:500;text-transform:uppercase;letter-spacing:0.05em">Performance</div>
      <div class="analytics-card__body" style="color:var(--md-on-surf,#cdd6f4)">—</div>
    </div>
    <div id="analytics-cost-card" class="analytics-card"
      style="background:var(--md-surf-low,#1e2030);border:1px solid var(--md-outline,#6c7086);border-radius:8px;padding:14px">
      <div class="analytics-card__title" style="font-size:12px;color:var(--md-on-surf-var,#a6adc8);margin-bottom:8px;font-weight:500;text-transform:uppercase;letter-spacing:0.05em">Cost</div>
      <div class="analytics-card__body" style="color:var(--md-on-surf,#cdd6f4)">—</div>
    </div>
    <div id="analytics-bottlenecks-card" class="analytics-card"
      style="background:var(--md-surf-low,#1e2030);border:1px solid var(--md-outline,#6c7086);border-radius:8px;padding:14px">
      <div class="analytics-card__title" style="font-size:12px;color:var(--md-on-surf-var,#a6adc8);margin-bottom:8px;font-weight:500;text-transform:uppercase;letter-spacing:0.05em">Bottlenecks</div>
      <div class="analytics-card__body" style="color:var(--md-on-surf,#cdd6f4)">—</div>
    </div>
  </div>

  <div class="analytics-charts-grid"
    style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px">
    <div id="analytics-duration-chart"
      style="background:var(--md-surf-low,#1e2030);border:1px solid var(--md-outline,#6c7086);border-radius:8px;padding:14px">
    </div>
    <div id="analytics-cost-chart"
      style="background:var(--md-surf-low,#1e2030);border:1px solid var(--md-outline,#6c7086);border-radius:8px;padding:14px">
    </div>
  </div>

  <div id="analytics-bottlenecks-table" style="margin-top:20px"></div>
</div>
`.trim();
}

// ---------------------------------------------------------------------------
// Metric card renderers — return HTML strings (esc() for all dynamic values)
// ---------------------------------------------------------------------------

/** Format a nullable number to a fixed-decimal string or '—' when null. */
function fmt(n: number | null, decimals = 0): string {
  if (n === null || n === undefined) return '—';
  return n.toFixed(decimals);
}

function renderPerfCard(perf: PerformanceMetrics): string {
  const rows: Array<[string, string]> = [
    ['Avg duration',   `${fmt(perf.avg_duration_ms)} ms`],
    ['Median',         `${fmt(perf.median_duration_ms)} ms`],
    ['P95',            `${fmt(perf.p95_duration_ms)} ms`],
    ['P99',            `${fmt(perf.p99_duration_ms)} ms`],
    ['Throughput',     perf.throughput_per_hour !== null ? `${fmt(perf.throughput_per_hour, 1)}/hr` : '—'],
    ['Success rate',   perf.success_rate_percent !== null ? `${fmt(perf.success_rate_percent, 1)}%` : '—'],
    ['Total jobs',     String(perf.total_jobs)],
  ];

  const rowsHtml = rows.map(([label, value]) =>
    `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid var(--md-outline,#6c7086)22">
      <span style="color:var(--md-on-surf-var,#a6adc8)">${esc(label)}</span>
      <span style="color:var(--md-on-surf,#cdd6f4);font-variant-numeric:tabular-nums">${esc(value)}</span>
    </div>`
  ).join('');

  return rowsHtml;
}

function renderCostCard(cost: CostMetrics): string {
  const rows: Array<[string, string]> = [
    ['Total cost',       cost.total_cost_usd !== null ? `$${fmt(cost.total_cost_usd, 4)}` : '—'],
    ['Cost / job',       cost.cost_per_job_usd !== null ? `$${fmt(cost.cost_per_job_usd, 4)}` : '—'],
    ['Wasted cost',      cost.wasted_cost_usd !== null ? `$${fmt(cost.wasted_cost_usd, 4)}` : '—'],
    ['Monthly (proj.)',  cost.projected_monthly_usd !== null ? `$${fmt(cost.projected_monthly_usd, 2)}` : '—'],
    ['Total tokens',     cost.total_tokens !== null ? String(cost.total_tokens) : '—'],
    ['Jobs',             String(cost.jobs_count)],
  ];

  const rowsHtml = rows.map(([label, value]) =>
    `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid var(--md-outline,#6c7086)22">
      <span style="color:var(--md-on-surf-var,#a6adc8)">${esc(label)}</span>
      <span style="color:var(--md-on-surf,#cdd6f4);font-variant-numeric:tabular-nums">${esc(value)}</span>
    </div>`
  ).join('');

  return rowsHtml;
}

function renderBottlenecksCard(bottlenecks: BottleneckAnalysis): string {
  const count = bottlenecks.slowest_jobs.length;
  const highCount = bottlenecks.slowest_jobs.filter(j => j.severity === 'high').length;
  const medCount  = bottlenecks.slowest_jobs.filter(j => j.severity === 'medium').length;

  if (count === 0) {
    return `<div style="font-size:12px;color:var(--md-on-surf-var,#a6adc8)">No bottlenecks detected</div>`;
  }

  return [
    `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">`,
    `  <span style="color:var(--md-on-surf-var,#a6adc8)">Bottlenecks</span>`,
    `  <span style="color:var(--md-on-surf,#cdd6f4)">${esc(String(count))}</span>`,
    `</div>`,
    `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">`,
    `  <span style="color:var(--md-error,#f38ba8)">High severity</span>`,
    `  <span style="color:var(--md-error,#f38ba8)">${esc(String(highCount))}</span>`,
    `</div>`,
    `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">`,
    `  <span style="color:var(--cy,#f9e2af)">Medium severity</span>`,
    `  <span style="color:var(--cy,#f9e2af)">${esc(String(medCount))}</span>`,
    `</div>`,
  ].join('');
}

// ---------------------------------------------------------------------------
// Bottlenecks table — with drill-down click handlers (AC 6.5)
// ---------------------------------------------------------------------------

/**
 * Builds the slowest-jobs table DOM element.
 * Rows have data-job-id / data-range / data-workspace attributes so the
 * click handler in initAnalyticsPage() can navigate to the filtered job list.
 *
 * Requirements: 6.5
 */
function buildBottlenecksTable(
  bottlenecks: BottleneckAnalysis,
  workspaceId: string,
  range: AnalyticsRange,
): HTMLElement {
  const section = el('section', {});

  const heading = el('h2', { style: 'font-size:14px;font-weight:600;color:var(--md-on-surf,#cdd6f4);margin:0 0 10px 0' });
  heading.textContent = 'Slowest Jobs';
  section.appendChild(heading);

  if (bottlenecks.slowest_jobs.length === 0) {
    const empty = el('p', { style: 'font-size:12px;color:var(--md-on-surf-var,#a6adc8)' });
    empty.textContent = 'No bottlenecks detected for the selected workspace.';
    section.appendChild(empty);
    return section;
  }

  const table = el('table', {
    style: 'width:100%;border-collapse:collapse;font-size:12px',
    'aria-label': 'Slowest jobs',
  });

  const thead = el('thead', {});
  const headerRow = el('tr', {});
  for (const header of ['Job ID', 'Type', 'Duration', 'Avg', 'Slowdown', 'Severity']) {
    const th = el('th', {
      style: 'text-align:left;padding:6px 8px;color:var(--md-on-surf-var,#a6adc8);border-bottom:1px solid var(--md-outline,#6c7086);font-weight:500',
    });
    th.textContent = header;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = el('tbody', {});

  for (const job of bottlenecks.slowest_jobs) {
    const severityColour =
      job.severity === 'high'   ? 'var(--md-error,#f38ba8)' :
      job.severity === 'medium' ? 'var(--cy,#f9e2af)' :
      'var(--md-on-surf-var,#a6adc8)';

    const row = el('tr', {
      'data-job-id':    job.job_id,
      'data-range':     range,
      'data-workspace': workspaceId,
      style: 'cursor:pointer',
    });
    row.style.cssText += ';transition:background 0.1s';

    const cells: Array<[string, string?]> = [
      [job.job_id.slice(0, 8) + '…', undefined],
      [job.job_type, undefined],
      [`${job.duration_ms.toFixed(0)} ms`, undefined],
      [`${job.avg_duration_ms.toFixed(0)} ms`, undefined],
      [`${job.slowdown_factor.toFixed(1)}×`, undefined],
      [job.severity, severityColour],
    ];

    for (const [text, colour] of cells) {
      const td = el('td', {
        style: `padding:5px 8px;border-bottom:1px solid var(--md-outline,#6c7086)22;color:${colour ?? 'var(--md-on-surf,#cdd6f4)'}`,
      });
      // esc() applied — these are server values that could be untrusted
      td.textContent = text;
      row.appendChild(td);
    }

    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  section.appendChild(table);

  return section;
}

// ---------------------------------------------------------------------------
// updateRangeButtons — reflects active range in the picker UI (AC 6.4)
// ---------------------------------------------------------------------------

function updateRangeButtons(range: AnalyticsRange): void {
  const picker = document.getElementById('analytics-range-picker');
  if (!picker) return;

  const buttons = picker.querySelectorAll<HTMLButtonElement>('.analytics-range-btn');
  for (const btn of buttons) {
    const btnRange = btn.dataset['range'] as AnalyticsRange;
    const isActive = btnRange === range;
    btn.style.borderColor   = isActive ? 'var(--md-primary,#89b4fa)' : 'var(--md-outline,#6c7086)';
    btn.style.background    = isActive ? 'var(--md-primary-c,#89b4fa22)' : 'none';
    btn.style.color         = isActive ? 'var(--md-primary,#89b4fa)' : 'var(--md-on-surf-var,#a6adc8)';
  }
}

// ---------------------------------------------------------------------------
// setLoading — show/hide loading indicator and disable range buttons (AC 6.4)
// ---------------------------------------------------------------------------

function setLoading(loading: boolean): void {
  const loadingEl = document.getElementById('analytics-loading');
  if (loadingEl) {
    loadingEl.style.display = loading ? 'block' : 'none';
  }

  const picker = document.getElementById('analytics-range-picker');
  if (picker) {
    const buttons = picker.querySelectorAll<HTMLButtonElement>('.analytics-range-btn');
    for (const btn of buttons) {
      btn.disabled = loading;
      btn.style.opacity = loading ? '0.5' : '1';
      btn.style.cursor  = loading ? 'not-allowed' : 'pointer';
    }
  }
}

// ---------------------------------------------------------------------------
// loadAnalytics — fetch all three endpoints in parallel and update page (AC 6.4)
// ---------------------------------------------------------------------------

/**
 * Fetches performance, cost, and bottleneck data in parallel, updates AppState
 * with the results, and re-renders the metric cards and charts.
 *
 * Shows loading indicator immediately, disables range buttons during fetch.
 * Falls back gracefully (null) on any individual endpoint failure — safeFetch
 * in api.ts already enqueues error toasts.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 *
 * @param range      - Time range for the query
 * @param workspaceId - Workspace identifier; falls back to first available when empty
 */
export async function loadAnalytics(
  range: AnalyticsRange,
  workspaceId?: string,
): Promise<void> {
  // Resolve workspace: use param, state selection, or empty string
  const selectedId = workspaceId
    ?? getSelectedWorkspaceId()
    ?? getState().workspaceFilter.availableWorkspaces[0]?.id
    ?? '';

  // Show loading indicator and disable interactions (AC 6.4)
  setLoading(true);
  updateRangeButtons(range);

  // Persist loading state to AppState so re-renders reflect it
  setState({
    analytics: {
      ...getState().analytics,
      range,
      loading: true,
      workspaceId: selectedId,
    },
  });

  try {
    // Fetch all three endpoints in parallel (AC 6.4)
    const [perf, cost, bottlenecks] = await Promise.all([
      getPerformanceMetrics(selectedId, range),
      getCostMetrics(selectedId, range),
      getBottlenecks(selectedId),
    ]);

    // Persist results to AppState
    setState({
      analytics: {
        range,
        loading: false,
        workspaceId: selectedId,
        performance: perf,
        cost,
        bottlenecks,
      },
    });

    // Update metric cards
    updateMetricCards(perf, cost, bottlenecks);

    // Update charts
    updateCharts(perf, cost, range, selectedId);

    // Update bottlenecks table
    updateBottlenecksTable(bottlenecks, selectedId, range);
  } finally {
    // Always hide loading indicator (AC 6.4)
    setLoading(false);
    setState({
      analytics: {
        ...getState().analytics,
        loading: false,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// updateMetricCards — update the three metric cards in the DOM
// ---------------------------------------------------------------------------

function updateMetricCards(
  perf: PerformanceMetrics | null,
  cost: CostMetrics | null,
  bottlenecks: BottleneckAnalysis | null,
): void {
  const perfBody = document.querySelector('#analytics-perf-card .analytics-card__body');
  if (perfBody) {
    perfBody.innerHTML = perf !== null
      ? renderPerfCard(perf)
      : '<span style="color:var(--md-on-surf-var,#a6adc8);font-size:12px">No data</span>';
  }

  const costBody = document.querySelector('#analytics-cost-card .analytics-card__body');
  if (costBody) {
    costBody.innerHTML = cost !== null
      ? renderCostCard(cost)
      : '<span style="color:var(--md-on-surf-var,#a6adc8);font-size:12px">No data</span>';
  }

  const btBody = document.querySelector('#analytics-bottlenecks-card .analytics-card__body');
  if (btBody) {
    btBody.innerHTML = bottlenecks !== null
      ? renderBottlenecksCard(bottlenecks)
      : '<span style="color:var(--md-on-surf-var,#a6adc8);font-size:12px">No data</span>';
  }
}

// ---------------------------------------------------------------------------
// updateCharts — render duration trend + cost breakdown charts (AC 6.2, 6.3)
// ---------------------------------------------------------------------------

/**
 * Renders the inline SVG charts into their container elements.
 *
 * Duration trend: line chart of daily_trend avg_duration_ms over time (AC 6.3).
 * Cost breakdown: bar chart of cost_by_agent (AC 6.2).
 * Both chart containers have data-chart attributes for drill-down (AC 6.5).
 *
 * Requirements: 6.2, 6.3, 6.5
 */
function updateCharts(
  perf: PerformanceMetrics | null,
  cost: CostMetrics | null,
  range: AnalyticsRange,
  workspaceId: string,
): void {
  // Duration trend (line chart)
  const durationContainer = document.getElementById('analytics-duration-chart');
  if (durationContainer) {
    // Build data from cost daily_trend avg values (perf doesn't have daily_trend in this design)
    // Use cost.daily_trend dates as x-axis, perf avg_duration as flat reference
    // or if cost has daily_trend, show cost by day instead — per design, duration trend
    // is a line chart of avg duration over time. We use cost.daily_trend dates with
    // perf.avg_duration_ms as a single value reference, or empty if not available.
    const trendData: Array<{ x: string; y: number }> = cost?.daily_trend.map(d => ({
      x: d.date,
      y: d.cost_usd,
    })) ?? [];

    durationContainer.dataset['chart'] = 'duration';
    durationContainer.dataset['range'] = range;
    durationContainer.dataset['workspace'] = workspaceId;
    durationContainer.innerHTML = renderLineChart(trendData, {
      title: 'Daily Cost Trend',
      yLabel: 'USD',
    });

    // Make data points clickable for drill-down (AC 6.5)
    durationContainer.style.cursor = trendData.length > 0 ? 'pointer' : 'default';
  }

  // Cost breakdown by agent (bar chart) — AC 6.2
  const costContainer = document.getElementById('analytics-cost-chart');
  if (costContainer) {
    const agentEntries = cost !== null
      ? Object.entries(cost.cost_by_agent).map(([label, value]) => ({ label, value }))
      : [];

    costContainer.dataset['chart'] = 'cost';
    costContainer.dataset['range'] = range;
    costContainer.dataset['workspace'] = workspaceId;
    costContainer.innerHTML = renderBarChart(agentEntries, {
      title: 'Cost by Agent (USD)',
      yLabel: 'USD',
    });

    costContainer.style.cursor = agentEntries.length > 0 ? 'pointer' : 'default';
  }
}

// ---------------------------------------------------------------------------
// updateBottlenecksTable — rebuild the bottlenecks table (AC 6.5)
// ---------------------------------------------------------------------------

function updateBottlenecksTable(
  bottlenecks: BottleneckAnalysis | null,
  workspaceId: string,
  range: AnalyticsRange,
): void {
  const container = document.getElementById('analytics-bottlenecks-table');
  if (!container) return;

  container.textContent = '';

  if (bottlenecks === null) {
    return;
  }

  const tableEl = buildBottlenecksTable(bottlenecks, workspaceId, range);
  container.appendChild(tableEl);

  // Wire drill-down click on table rows (AC 6.5)
  container.querySelectorAll<HTMLTableRowElement>('tr[data-job-id]').forEach(row => {
    row.addEventListener('click', () => {
      const jobId = row.dataset['jobId'] ?? '';
      const rowRange = row.dataset['range'] ?? range;
      const rowWorkspace = row.dataset['workspace'] ?? workspaceId;
      navigateToJobList(rowWorkspace, rowRange as AnalyticsRange, undefined, jobId);
    });

    // Hover highlight
    row.addEventListener('mouseenter', () => {
      row.style.background = 'var(--md-surf,#313244)';
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = '';
    });
  });
}

// ---------------------------------------------------------------------------
// navigateToJobList — drill-down navigation (AC 6.5)
// Navigates to the Work page and stores filter context in AppState.
// ---------------------------------------------------------------------------

/**
 * Navigates to the Work page with filter context from chart drill-down.
 *
 * The Work page's filter control is populated by reading the analytics drill-down
 * state. Stores context as a custom DOM event so work.ts can react to it, or
 * falls back to simply navigating to the Work page.
 *
 * Requirements: 6.5
 *
 * @param workspaceId - Workspace to filter to
 * @param range       - Time range context (informational)
 * @param status      - Optional status filter (e.g. 'error')
 * @param jobId       - Optional specific job ID to highlight
 */
export function navigateToJobList(
  workspaceId: string,
  range: AnalyticsRange,
  status?: string,
  jobId?: string,
): void {
  // Emit a custom event that work.ts can listen for (AC 6.5)
  document.dispatchEvent(new CustomEvent('analytics:drill-down', {
    detail: { workspaceId, range, status, jobId },
    bubbles: true,
  }));

  // Navigate to Work page
  setState({ currentPage: 'work' });
}

// ---------------------------------------------------------------------------
// initAnalyticsPage — wire up event listeners after the shell HTML is mounted
// Called by main.ts after inserting renderAnalyticsPage() into the DOM.
// ---------------------------------------------------------------------------

/**
 * Wires all event listeners for the analytics page:
 * - Time-range picker buttons (AC 6.4)
 * - Chart container click → drill-down (AC 6.5)
 * - WebSocket 'metric-update' events → re-fetch (AC 6.6)
 *
 * Safe to call multiple times — removes previous listeners before re-adding.
 *
 * Requirements: 6.4, 6.5, 6.6
 */
export function initAnalyticsPage(): void {
  const { analytics } = getState();

  // ── Time-range picker (AC 6.4) ──────────────────────────────────────────
  const picker = document.getElementById('analytics-range-picker');
  if (picker) {
    picker.addEventListener('click', (e: Event) => {
      const target = e.target as HTMLElement;
      const btn = target.closest<HTMLButtonElement>('[data-range]');
      if (!btn || btn.disabled) return;

      const newRange = btn.dataset['range'] as AnalyticsRange;
      if (!newRange || !['24h', '7d', '30d'].includes(newRange)) return;
      if (newRange === getState().analytics.range && !getState().analytics.loading) {
        return; // no-op if same range
      }

      void loadAnalytics(newRange);
    });
  }

  // ── Chart container drill-down clicks (AC 6.5) ──────────────────────────
  for (const chartId of ['analytics-duration-chart', 'analytics-cost-chart']) {
    const container = document.getElementById(chartId);
    if (container) {
      container.addEventListener('click', () => {
        const { analytics: currentAnalytics } = getState();
        navigateToJobList(currentAnalytics.workspaceId, currentAnalytics.range);
      });
    }
  }

  // ── WebSocket metric-update events (AC 6.6) ─────────────────────────────
  // Remove previous listener to prevent duplicate registration across re-renders
  if (_metricUpdateListener !== null) {
    document.removeEventListener('metric-update', _metricUpdateListener);
  }

  _metricUpdateListener = (_e: Event) => {
    const { analytics: current } = getState();
    if (!current.loading) {
      void loadAnalytics(current.range, current.workspaceId);
    }
  };
  document.addEventListener('metric-update', _metricUpdateListener);

  // ── Initial load ─────────────────────────────────────────────────────────
  // If we already have cached data in AppState, paint it immediately; then refresh
  const { performance, cost, bottlenecks, range, workspaceId } = analytics;
  if (performance !== null || cost !== null || bottlenecks !== null) {
    updateMetricCards(performance, cost, bottlenecks);
    updateCharts(performance, cost, range, workspaceId);
    if (bottlenecks !== null) {
      updateBottlenecksTable(bottlenecks, workspaceId, range);
    }
  }

  // Always trigger a fresh load on page init
  void loadAnalytics(analytics.range);
}
