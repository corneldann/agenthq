// components/lineChart.ts — inline SVG line chart component
// Pure function — no DOM access, no side effects (SSR-style string output).
// Requirements: 6.3, 6.7

import { esc } from '../utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single data point for the line chart. */
export type LineChartDataPoint = {
  /** X-axis label (e.g. date string "2024-03-15"). */
  x: string;
  /** Y-axis numeric value. */
  y: number;
};

/** Options controlling the chart's appearance and labelling. */
export type LineChartOpts = {
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
  /** CSS colour for the line and data-point dots. Defaults to primary token. */
  lineColour?: string;
};

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const DEFAULT_WIDTH  = 400;
const DEFAULT_HEIGHT = 220;

/** Pixels reserved at the top for the title and topmost data-point labels. */
const PADDING_TOP = 28;
/** Pixels reserved at the bottom for x-axis labels. */
const PADDING_BOTTOM = 40;
/** Pixels reserved on the left for the y-axis labels and optional y-label. */
const PADDING_LEFT = 52;
/** Pixels reserved on the right. */
const PADDING_RIGHT = 12;

/** Number of y-axis gridlines / tick marks to draw. */
const Y_TICK_COUNT = 4;

/** Radius of the dot drawn on each data point. */
const DOT_RADIUS = 3;

/** CSS colour for the polyline and dots. */
const LINE_COLOUR  = 'var(--md-primary, #89b4fa)';
/** CSS colour for axis lines, gridlines, and tick labels. */
const AXIS_COLOUR  = 'var(--md-outline, #6c7086)';
/** CSS colour for the semi-transparent area fill under the line. */
const FILL_COLOUR  = 'var(--md-primary, #89b4fa)';
/** CSS colour for text labels (value, x-labels). */
const LABEL_COLOUR = 'var(--md-on-surf-var, #a6adc8)';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a y-axis tick value compactly. */
function formatTick(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return parseFloat(n.toFixed(1)).toString();
}

/** Truncate a label to maxLen chars, appending '…' when truncated. */
function truncateLabel(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

/**
 * Map a y-value to a pixel coordinate within the chart area.
 * minY === maxY means all values are equal — render at the mid-line.
 */
function mapY(v: number, minY: number, maxY: number, chartTop: number, chartBottom: number): number {
  if (maxY === minY) return (chartTop + chartBottom) / 2;
  return chartBottom - ((v - minY) / (maxY - minY)) * (chartBottom - chartTop);
}

// ---------------------------------------------------------------------------
// renderLineChart
// ---------------------------------------------------------------------------

/**
 * renderLineChart — renders an inline SVG line chart as an HTML string.
 *
 * The function is pure: given the same `data` and `opts` it always returns the
 * same string. It accesses no globals and has no side effects.
 *
 * All dynamic string values (labels, title, yLabel) are HTML-escaped via
 * `esc()` before insertion to prevent XSS.
 *
 * Data points are connected with a `<polyline>` element. An optional shaded
 * area fill is drawn beneath the line for visual clarity.
 *
 * When `data` is empty, a placeholder SVG is returned instead of an empty
 * chart (AC 6.7).
 *
 * @param data - Array of `{x, y}` data points in the order they should
 *               appear left-to-right. Non-finite y-values are treated as 0.
 * @param opts - Optional chart configuration.
 * @returns An HTML string containing an inline `<svg>` element (or a
 *          placeholder `<div>` when `data` is empty).
 *
 * @example
 * renderLineChart(
 *   [{ x: '2024-03-01', y: 120 }, { x: '2024-03-02', y: 95 }],
 *   { title: 'Average Duration (ms)', yLabel: 'ms' }
 * )
 */
export function renderLineChart(
  data: ReadonlyArray<LineChartDataPoint>,
  opts: LineChartOpts = {},
): string {
  const {
    title,
    yLabel,
    width  = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    lineColour = LINE_COLOUR,
  } = opts;

  // ── Empty-state placeholder (AC 6.7) ─────────────────────────────────────
  if (data.length === 0) {
    const titleHtml = title
      ? `<div class="chart-title" style="font-size:13px;color:${LABEL_COLOUR};margin-bottom:6px">${esc(title)}</div>`
      : '';
    return (
      `<div class="line-chart line-chart--empty" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:${height}px;color:${AXIS_COLOUR}">` +
      titleHtml +
      `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title ?? 'Line chart')} — no data">` +
      `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="middle" ` +
      `fill="${AXIS_COLOUR}" font-size="14" font-family="inherit">No data</text>` +
      `</svg>` +
      `</div>`
    );
  }

  // ── Normalise y-values: treat non-finite as 0 ────────────────────────────
  const yValues = data.map((d) => {
    const v = Number(d.y);
    return isFinite(v) ? v : 0;
  });

  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);

  // ── Chart dimensions ───────────────────────────────────────────────────────
  const chartLeft   = PADDING_LEFT;
  const chartRight  = width  - PADDING_RIGHT;
  const chartTop    = PADDING_TOP;
  const chartBottom = height - PADDING_BOTTOM;
  const chartWidth  = chartRight - chartLeft;

  const n = data.length;

  // ── Compute pixel coordinates for each data point ────────────────────────
  // Single-point: place at horizontal centre
  const xCoords: number[] = n === 1
    ? [chartLeft + chartWidth / 2]
    : data.map((_, i) => chartLeft + (i / (n - 1)) * chartWidth);

  const yCoords: number[] = yValues.map((v) =>
    mapY(v, minY, maxY, chartTop, chartBottom),
  );

  // ── Polyline points string ─────────────────────────────────────────────────
  const polylinePoints = xCoords
    .map((x, i) => `${x.toFixed(1)},${yCoords[i].toFixed(1)}`)
    .join(' ');

  // ── Area fill path (close back along the bottom axis) ────────────────────
  const firstX = xCoords[0].toFixed(1);
  const lastX  = xCoords[xCoords.length - 1].toFixed(1);
  const areaPath =
    `M ${firstX},${chartBottom} ` +
    xCoords.map((x, i) => `L ${x.toFixed(1)},${yCoords[i].toFixed(1)}`).join(' ') +
    ` L ${lastX},${chartBottom} Z`;

  // ── Y-axis ticks and gridlines ────────────────────────────────────────────
  const yTickElements: string[] = [];
  for (let t = 0; t <= Y_TICK_COUNT; t++) {
    const fraction = t / Y_TICK_COUNT;
    const tickValue = minY + fraction * (maxY - minY);
    const yPx = mapY(tickValue, minY, maxY, chartTop, chartBottom);

    // Gridline
    yTickElements.push(
      `<line ` +
        `x1="${chartLeft}" y1="${yPx.toFixed(1)}" ` +
        `x2="${chartRight}" y2="${yPx.toFixed(1)}" ` +
        `stroke="${AXIS_COLOUR}" stroke-width="0.5" stroke-dasharray="3,3" opacity="0.5"` +
      `/>`,
    );

    // Tick label
    yTickElements.push(
      `<text ` +
        `x="${chartLeft - 6}" ` +
        `y="${yPx.toFixed(1)}" ` +
        `text-anchor="end" ` +
        `dominant-baseline="middle" ` +
        `fill="${LABEL_COLOUR}" ` +
        `font-size="10" ` +
        `font-family="inherit"` +
      `>${esc(formatTick(tickValue))}</text>`,
    );
  }

  // ── X-axis labels ─────────────────────────────────────────────────────────
  // Show at most ~6 labels to avoid overlap; pick evenly-spaced indices.
  const maxXLabels = Math.min(n, 6);
  const xLabelIndices = n <= maxXLabels
    ? Array.from({ length: n }, (_, i) => i)
    : Array.from({ length: maxXLabels }, (_, i) =>
        Math.round(i * (n - 1) / (maxXLabels - 1)),
      );

  const xLabelElements: string[] = xLabelIndices.map((idx) => {
    const xPx   = xCoords[idx];
    const label = data[idx].x;
    // Allocate slot width per label; ~7px per char
    const slotPx  = maxXLabels > 1 ? chartWidth / maxXLabels : chartWidth;
    const maxChars = Math.max(1, Math.floor(slotPx / 7));
    const truncated = truncateLabel(label, maxChars);

    return (
      `<text ` +
        `x="${xPx.toFixed(1)}" ` +
        `y="${chartBottom + 16}" ` +
        `text-anchor="middle" ` +
        `dominant-baseline="hanging" ` +
        `fill="${LABEL_COLOUR}" ` +
        `font-size="10" ` +
        `font-family="inherit"` +
      `>${esc(truncated)}</text>`
    );
  });

  // ── Data-point dots ────────────────────────────────────────────────────────
  // For large datasets (>100 points) skip individual dots for performance.
  const dotElements: string[] = n <= 100
    ? xCoords.map((x, i) =>
        `<circle ` +
          `cx="${x.toFixed(1)}" ` +
          `cy="${yCoords[i].toFixed(1)}" ` +
          `r="${DOT_RADIUS}" ` +
          `fill="${lineColour}" ` +
          `role="presentation"` +
        `>` +
          `<title>${esc(data[i].x)}: ${esc(formatTick(yValues[i]))}</title>` +
        `</circle>`,
      )
    : [];

  // ── Axis lines ─────────────────────────────────────────────────────────────
  const axisLines = [
    // Horizontal baseline
    `<line ` +
      `x1="${chartLeft}" y1="${chartBottom}" ` +
      `x2="${chartRight}" y2="${chartBottom}" ` +
      `stroke="${AXIS_COLOUR}" stroke-width="1"` +
    `/>`,
    // Vertical left axis
    `<line ` +
      `x1="${chartLeft}" y1="${chartTop}" ` +
      `x2="${chartLeft}" y2="${chartBottom}" ` +
      `stroke="${AXIS_COLOUR}" stroke-width="1"` +
    `/>`,
  ];

  // ── Y-axis label (optional, rotated) ─────────────────────────────────────
  const yLabelEl = yLabel
    ? `<text ` +
        `x="${PADDING_LEFT - 40}" ` +
        `y="${chartTop + (chartBottom - chartTop) / 2}" ` +
        `text-anchor="middle" ` +
        `dominant-baseline="middle" ` +
        `fill="${AXIS_COLOUR}" ` +
        `font-size="11" ` +
        `font-family="inherit" ` +
        `transform="rotate(-90, ${PADDING_LEFT - 40}, ${chartTop + (chartBottom - chartTop) / 2})"` +
      `>${esc(yLabel)}</text>`
    : '';

  // ── Title ─────────────────────────────────────────────────────────────────
  const titleEl = title
    ? `<text ` +
        `x="${width / 2}" ` +
        `y="14" ` +
        `text-anchor="middle" ` +
        `dominant-baseline="hanging" ` +
        `fill="${LABEL_COLOUR}" ` +
        `font-size="13" ` +
        `font-weight="500" ` +
        `font-family="inherit"` +
      `>${esc(title)}</text>`
    : '';

  // ── Assemble SVG ──────────────────────────────────────────────────────────
  const ariaLabel = title ? esc(title) : 'Line chart';

  const svgParts = [
    titleEl,
    yLabelEl,
    // Gridlines and y-tick labels
    ...yTickElements,
    // Axis lines on top of gridlines
    ...axisLines,
    // Area fill (semi-transparent)
    `<path d="${areaPath}" fill="${FILL_COLOUR}" fill-opacity="0.08" stroke="none"/>`,
    // Polyline
    `<polyline ` +
      `points="${polylinePoints}" ` +
      `fill="none" ` +
      `stroke="${lineColour}" ` +
      `stroke-width="2" ` +
      `stroke-linejoin="round" ` +
      `stroke-linecap="round"` +
    `/>`,
    // Dots
    ...dotElements,
    // X-axis labels
    ...xLabelElements,
  ].filter(Boolean).join('\n  ');

  return (
    `<div class="line-chart">` +
    `<svg ` +
      `width="100%" ` +
      `height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" ` +
      `role="img" ` +
      `aria-label="${ariaLabel}"` +
    `>` +
    `\n  ${svgParts}\n` +
    `</svg>` +
    `</div>`
  );
}
