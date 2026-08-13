// components/barChart.ts — inline SVG bar chart component
// Pure function — no DOM access, no side effects (SSR-style string output).
// Requirements: 6.2, 6.7

import { esc } from '../utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single data point for the bar chart. */
export type BarChartDataPoint = {
  label: string;
  value: number;
};

/** Options controlling the chart's appearance and labelling. */
export type BarChartOpts = {
  /** Optional chart title rendered above the SVG. */
  title?: string;
  /** Optional y-axis label rendered vertically on the left. */
  yLabel?: string;
  /**
   * Width of the SVG viewport in pixels. Defaults to 400.
   * The chart scales responsively via `width="100%"` + `viewBox`.
   */
  width?: number;
  /** Height of the SVG viewport in pixels. Defaults to 220. */
  height?: number;
};

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const DEFAULT_WIDTH  = 400;
const DEFAULT_HEIGHT = 220;

/** Pixels reserved at the top for value labels above bars. */
const PADDING_TOP = 24;
/** Pixels reserved at the bottom for axis + bar labels. */
const PADDING_BOTTOM = 40;
/** Pixels reserved on the left for the y-axis label (when present). */
const PADDING_LEFT = 36;
/** Pixels reserved on the right. */
const PADDING_RIGHT = 12;

/** Gap between adjacent bars as a fraction of the available bar slot width. */
const BAR_GAP_RATIO = 0.2;

/** CSS colour for bars. */
const BAR_COLOUR = 'var(--md-primary, #89b4fa)';
/** CSS colour for axis lines and labels. */
const AXIS_COLOUR = 'var(--md-outline, #6c7086)';
/** CSS colour for value labels above bars. */
const VALUE_LABEL_COLOUR = 'var(--md-on-surf, #cdd6f4)';
/** CSS colour for bar category labels below bars. */
const BAR_LABEL_COLOUR = 'var(--md-on-surf-var, #a6adc8)';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a number compactly for display as a bar value label. */
function formatValue(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  // Show up to 2 decimal places, strip trailing zeros
  return parseFloat(n.toFixed(2)).toString();
}

/** Truncate a label to maxLen chars, appending '…' when truncated. */
function truncateLabel(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

// ---------------------------------------------------------------------------
// renderBarChart
// ---------------------------------------------------------------------------

/**
 * renderBarChart — renders an inline SVG bar chart as an HTML string.
 *
 * The function is pure: given the same `data` and `opts` it always returns the
 * same string. It accesses no globals and has no side effects.
 *
 * All dynamic string values (labels, title, yLabel) are HTML-escaped via
 * `esc()` before insertion to prevent XSS.
 *
 * When `data` is empty or every bar value is 0, a placeholder is returned
 * instead of an empty SVG (AC 6.7).
 *
 * @param data - Array of `{label, value}` data points. Non-finite values are
 *               treated as 0. Negative values are clamped to 0 for the bar
 *               height (negative metrics are invalid per design invariants).
 * @param opts - Optional chart configuration.
 * @returns An HTML string containing an inline `<svg>` element (or a
 *          placeholder `<div>` when `data` is empty).
 *
 * @example
 * renderBarChart(
 *   [{ label: 'Claude', value: 1.23 }, { label: 'GPT-4', value: 0.87 }],
 *   { title: 'Cost by Agent (USD)' }
 * )
 */
export function renderBarChart(
  data: ReadonlyArray<BarChartDataPoint>,
  opts: BarChartOpts = {},
): string {
  const {
    title,
    yLabel,
    width  = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
  } = opts;

  // ── Empty-state placeholder (AC 6.7) ─────────────────────────────────────
  if (data.length === 0) {
    const titleHtml = title
      ? `<div class="chart-title" style="font-size:13px;color:${BAR_LABEL_COLOUR};margin-bottom:6px">${esc(title)}</div>`
      : '';
    return (
      `<div class="bar-chart bar-chart--empty" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:${height}px;color:${AXIS_COLOUR}">` +
      titleHtml +
      `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title ?? 'Bar chart')} — no data">` +
      `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="middle" ` +
      `fill="${AXIS_COLOUR}" font-size="14" font-family="inherit">No data</text>` +
      `</svg>` +
      `</div>`
    );
  }

  // ── Normalise values: treat non-finite as 0, clamp negatives to 0 ─────────
  const values = data.map((d) => {
    const v = Number(d.value);
    return isFinite(v) ? Math.max(0, v) : 0;
  });

  const maxValue = Math.max(...values);

  // ── Chart dimensions ───────────────────────────────────────────────────────
  const chartLeft   = PADDING_LEFT;
  const chartRight  = width  - PADDING_RIGHT;
  const chartTop    = PADDING_TOP;
  const chartBottom = height - PADDING_BOTTOM;
  const chartWidth  = chartRight - chartLeft;
  const chartHeight = chartBottom - chartTop;

  const n          = data.length;
  const slotWidth  = chartWidth / n;
  const barWidth   = slotWidth * (1 - BAR_GAP_RATIO);
  const barOffset  = slotWidth * (BAR_GAP_RATIO / 2); // gap on each side

  // ── Build bar elements ────────────────────────────────────────────────────
  const barElements: string[] = [];

  for (let i = 0; i < n; i++) {
    const v        = values[i];
    const label    = data[i].label;
    const xSlot    = chartLeft + i * slotWidth;
    const xBar     = xSlot + barOffset;

    // Bar height: proportional to maxValue; 0 when maxValue is 0
    const barH     = maxValue > 0 ? (v / maxValue) * chartHeight : 0;
    const yBar     = chartBottom - barH;

    // Value label centred above the bar (or at bar top when bar height is 0)
    const xMid     = xBar + barWidth / 2;
    const yValueLabel = yBar - 4;

    // Category label centred below the axis
    const yBarLabel = chartBottom + 16;

    // Truncate long labels to fit within the slot (roughly 7px per char)
    const maxChars = Math.max(1, Math.floor(slotWidth / 7));
    const truncated = truncateLabel(label, maxChars);

    barElements.push(
      // Bar rectangle
      `<rect ` +
        `x="${xBar.toFixed(1)}" ` +
        `y="${yBar.toFixed(1)}" ` +
        `width="${barWidth.toFixed(1)}" ` +
        `height="${barH.toFixed(1)}" ` +
        `fill="${BAR_COLOUR}" ` +
        `rx="2" ry="2" ` +
        `role="presentation"` +
      `>` +
        `<title>${esc(label)}: ${esc(formatValue(v))}</title>` +
      `</rect>`,

      // Value label above bar
      `<text ` +
        `x="${xMid.toFixed(1)}" ` +
        `y="${yValueLabel.toFixed(1)}" ` +
        `text-anchor="middle" ` +
        `dominant-baseline="auto" ` +
        `fill="${VALUE_LABEL_COLOUR}" ` +
        `font-size="11" ` +
        `font-family="inherit"` +
      `>${esc(formatValue(v))}</text>`,

      // Category label below axis
      `<text ` +
        `x="${xMid.toFixed(1)}" ` +
        `y="${yBarLabel.toFixed(1)}" ` +
        `text-anchor="middle" ` +
        `dominant-baseline="hanging" ` +
        `fill="${BAR_LABEL_COLOUR}" ` +
        `font-size="11" ` +
        `font-family="inherit"` +
      `>${esc(truncated)}</text>`,
    );
  }

  // ── Axis lines ─────────────────────────────────────────────────────────────
  // Horizontal baseline
  const axisLine =
    `<line ` +
      `x1="${chartLeft}" y1="${chartBottom}" ` +
      `x2="${chartRight}" y2="${chartBottom}" ` +
      `stroke="${AXIS_COLOUR}" stroke-width="1"` +
    `/>`;

  // ── Y-axis label (optional, rotated) ─────────────────────────────────────
  const yLabelEl = yLabel
    ? `<text ` +
        `x="${PADDING_LEFT - 28}" ` +
        `y="${chartTop + chartHeight / 2}" ` +
        `text-anchor="middle" ` +
        `dominant-baseline="middle" ` +
        `fill="${AXIS_COLOUR}" ` +
        `font-size="11" ` +
        `font-family="inherit" ` +
        `transform="rotate(-90, ${PADDING_LEFT - 28}, ${chartTop + chartHeight / 2})"` +
      `>${esc(yLabel)}</text>`
    : '';

  // ── Title ─────────────────────────────────────────────────────────────────
  const titleEl = title
    ? `<text ` +
        `x="${width / 2}" ` +
        `y="14" ` +
        `text-anchor="middle" ` +
        `dominant-baseline="hanging" ` +
        `fill="${VALUE_LABEL_COLOUR}" ` +
        `font-size="13" ` +
        `font-weight="500" ` +
        `font-family="inherit"` +
      `>${esc(title)}</text>`
    : '';

  // ── Assemble SVG ──────────────────────────────────────────────────────────
  const ariaLabel = title ? esc(title) : 'Bar chart';
  const svgContents = [
    titleEl,
    yLabelEl,
    axisLine,
    ...barElements,
  ].filter(Boolean).join('\n  ');

  return (
    `<div class="bar-chart">` +
    `<svg ` +
      `width="100%" ` +
      `height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" ` +
      `role="img" ` +
      `aria-label="${ariaLabel}"` +
    `>` +
    `\n  ${svgContents}\n` +
    `</svg>` +
    `</div>`
  );
}
