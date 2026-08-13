// test/dashboard/chartComponents.test.ts
// Unit tests for renderBarChart and renderLineChart components.
// Requirements: 6.7

import { describe, it, expect } from 'bun:test';
import { renderBarChart } from '../../src/dashboard/components/barChart.js';
import { renderLineChart } from '../../src/dashboard/components/lineChart.js';
import type { BarChartDataPoint } from '../../src/dashboard/components/barChart.js';
import type { LineChartDataPoint } from '../../src/dashboard/components/lineChart.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Characters that must never appear raw (unescaped) in rendered output
 *  when they originate from user-supplied label strings. */
const XSS_PAYLOAD = '<script>alert("xss")</script>';

/** Confirm the rendered HTML does not contain any of the three raw chars
 *  that originated from the injected label. The expected escaped forms are
 *  &lt;, &gt;, and &quot;. */
function hasRawXssChars(html: string, rawCharsFromLabel: string): boolean {
  // We look for the exact raw substring from the user label inside the HTML.
  // If the label was escaped correctly, the raw form will not appear.
  return html.includes(rawCharsFromLabel);
}

// ---------------------------------------------------------------------------
// describe: renderBarChart
// ---------------------------------------------------------------------------

describe('renderBarChart', () => {

  // ── Valid data ─────────────────────────────────────────────────────────────

  it('should return a non-empty string containing <svg for valid data', () => {
    // Arrange
    const data: BarChartDataPoint[] = [
      { label: 'Claude', value: 1.23 },
      { label: 'GPT-4',  value: 0.87 },
    ];

    // Act
    const result = renderBarChart(data);

    // Assert
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('<svg');
  });

  it('should include a <rect element for each data point', () => {
    // Arrange
    const data: BarChartDataPoint[] = [
      { label: 'A', value: 10 },
      { label: 'B', value: 20 },
      { label: 'C', value: 30 },
    ];

    // Act
    const result = renderBarChart(data);

    // Assert — one <rect per bar
    const rectMatches = result.match(/<rect /g);
    expect(rectMatches).not.toBeNull();
    expect(rectMatches!.length).toBe(3);
  });

  it('should render the bar label text in the SVG output', () => {
    // Arrange
    const data: BarChartDataPoint[] = [{ label: 'MyAgent', value: 42 }];

    // Act
    const result = renderBarChart(data);

    // Assert — the label appears somewhere in the output (possibly truncated)
    // At minimum the title element inside the rect must contain the full label
    expect(result).toContain('MyAgent');
  });

  it('should accept a single data point without throwing', () => {
    // Arrange
    const data: BarChartDataPoint[] = [{ label: 'Solo', value: 5 }];

    // Act
    const result = renderBarChart(data);

    // Assert
    expect(result).toContain('<svg');
    expect(result).toContain('<rect ');
  });

  it('should accept all-zero values and still render bars with height 0', () => {
    // Arrange
    const data: BarChartDataPoint[] = [
      { label: 'A', value: 0 },
      { label: 'B', value: 0 },
    ];

    // Act
    const result = renderBarChart(data);

    // Assert — still valid SVG output
    expect(result).toContain('<svg');
    // height attribute on rect should be "0.0" when all values are 0
    expect(result).toContain('height="0.0"');
  });

  // ── Empty data → placeholder SVG ──────────────────────────────────────────

  it('should return a placeholder SVG (not an empty string) when data is []', () => {
    // Act
    const result = renderBarChart([]);

    // Assert — still contains a valid SVG element
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('<svg');
  });

  it('should include "No data" text in placeholder when data is []', () => {
    // Act
    const result = renderBarChart([]);

    // Assert
    expect(result).toContain('No data');
  });

  it('should include the bar-chart--empty class when data is []', () => {
    // Act
    const result = renderBarChart([]);

    // Assert
    expect(result).toContain('bar-chart--empty');
  });

  it('should include an aria-label on the placeholder SVG', () => {
    // Act
    const result = renderBarChart([], { title: 'Cost by Agent' });

    // Assert — aria-label includes the title
    expect(result).toContain('aria-label=');
    expect(result).toContain('Cost by Agent');
  });

  // ── XSS — label escaping ───────────────────────────────────────────────────

  it('should not contain raw < from a label containing <script>', () => {
    // Arrange
    const data: BarChartDataPoint[] = [{ label: XSS_PAYLOAD, value: 5 }];

    // Act
    const result = renderBarChart(data);

    // Assert — the raw XSS payload must not appear literally in the output.
    // We check each dangerous character individually so the assertion is precise.
    // The payload contains <, > and " — all three should be escaped.
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('</script>');
    // Escaped forms must be present instead
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('&quot;xss&quot;');
  });

  it('should escape < > " in the chart title option', () => {
    // Arrange
    const data: BarChartDataPoint[] = [{ label: 'Normal', value: 1 }];

    // Act
    const result = renderBarChart(data, { title: '<b>"Injected"</b>' });

    // Assert
    expect(result).not.toContain('<b>');
    expect(result).toContain('&lt;b&gt;');
    expect(result).toContain('&quot;Injected&quot;');
  });

  it('should escape < > " in the yLabel option', () => {
    // Arrange
    const data: BarChartDataPoint[] = [{ label: 'A', value: 1 }];

    // Act
    const result = renderBarChart(data, { yLabel: '"<USD>"' });

    // Assert
    expect(result).not.toContain('"<USD>"');
    expect(result).toContain('&quot;&lt;USD&gt;&quot;');
  });

  it('should escape special chars in empty-state title', () => {
    // Arrange (empty data, title with XSS)
    const result = renderBarChart([], { title: '<img src=x onerror="alert(1)">' });

    // Assert
    expect(result).not.toContain('<img');
    expect(result).toContain('&lt;img');
  });

});

// ---------------------------------------------------------------------------
// describe: renderLineChart
// ---------------------------------------------------------------------------

describe('renderLineChart', () => {

  // ── Valid data ─────────────────────────────────────────────────────────────

  it('should return a non-empty string containing <svg for valid data', () => {
    // Arrange
    const data: LineChartDataPoint[] = [
      { x: '2024-03-01', y: 120 },
      { x: '2024-03-02', y: 95  },
    ];

    // Act
    const result = renderLineChart(data);

    // Assert
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('<svg');
  });

  it('should include a <polyline element for valid data', () => {
    // Arrange
    const data: LineChartDataPoint[] = [
      { x: '2024-03-01', y: 100 },
      { x: '2024-03-02', y: 200 },
      { x: '2024-03-03', y: 150 },
    ];

    // Act
    const result = renderLineChart(data);

    // Assert
    expect(result).toContain('<polyline');
  });

  it('should render one <circle dot per data point for small datasets', () => {
    // Arrange — 3 points, all below the 100-point threshold for dots
    const data: LineChartDataPoint[] = [
      { x: 'Mon', y: 10 },
      { x: 'Tue', y: 20 },
      { x: 'Wed', y: 15 },
    ];

    // Act
    const result = renderLineChart(data);

    // Assert
    const circleMatches = result.match(/<circle /g);
    expect(circleMatches).not.toBeNull();
    expect(circleMatches!.length).toBe(3);
  });

  it('should accept a single data point without throwing', () => {
    // Arrange
    const data: LineChartDataPoint[] = [{ x: '2024-01-01', y: 42 }];

    // Act
    const result = renderLineChart(data);

    // Assert
    expect(result).toContain('<svg');
    expect(result).toContain('<polyline');
  });

  it('should handle all-equal y values (flat line) without throwing', () => {
    // Arrange — equal values cause minY === maxY; the chart should render at mid-line
    const data: LineChartDataPoint[] = [
      { x: 'A', y: 50 },
      { x: 'B', y: 50 },
      { x: 'C', y: 50 },
    ];

    // Act
    const result = renderLineChart(data);

    // Assert
    expect(result).toContain('<svg');
    expect(result).toContain('<polyline');
  });

  // ── Empty data → placeholder SVG ──────────────────────────────────────────

  it('should return a placeholder SVG (not an empty string) when data is []', () => {
    // Act
    const result = renderLineChart([]);

    // Assert — still contains a valid SVG element
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('<svg');
  });

  it('should include "No data" text in placeholder when data is []', () => {
    // Act
    const result = renderLineChart([]);

    // Assert
    expect(result).toContain('No data');
  });

  it('should include the line-chart--empty class when data is []', () => {
    // Act
    const result = renderLineChart([]);

    // Assert
    expect(result).toContain('line-chart--empty');
  });

  it('should include an aria-label on the placeholder SVG', () => {
    // Act
    const result = renderLineChart([], { title: 'Duration Trend' });

    // Assert
    expect(result).toContain('aria-label=');
    expect(result).toContain('Duration Trend');
  });

  // ── XSS — label escaping ───────────────────────────────────────────────────

  it('should not contain raw < from an x label containing <script>', () => {
    // Arrange
    const data: LineChartDataPoint[] = [
      { x: XSS_PAYLOAD, y: 100 },
    ];

    // Act
    const result = renderLineChart(data);

    // Assert — raw XSS chars must not appear literally
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('</script>');
    // Escaped forms must be present
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('&quot;xss&quot;');
  });

  it('should escape < > " in the chart title option', () => {
    // Arrange
    const data: LineChartDataPoint[] = [{ x: '2024-01-01', y: 1 }];

    // Act
    const result = renderLineChart(data, { title: '<em>"Injected"</em>' });

    // Assert
    expect(result).not.toContain('<em>');
    expect(result).toContain('&lt;em&gt;');
    expect(result).toContain('&quot;Injected&quot;');
  });

  it('should escape < > " in the yLabel option', () => {
    // Arrange
    const data: LineChartDataPoint[] = [{ x: '2024-01-01', y: 1 }];

    // Act
    const result = renderLineChart(data, { yLabel: '"<ms>"' });

    // Assert
    expect(result).not.toContain('"<ms>"');
    expect(result).toContain('&quot;&lt;ms&gt;&quot;');
  });

  it('should escape special chars in empty-state title', () => {
    // Arrange (empty data, title with XSS)
    const result = renderLineChart([], { title: '<img src=x onerror="alert(1)">' });

    // Assert
    expect(result).not.toContain('<img');
    expect(result).toContain('&lt;img');
  });

  // ── Cross-component: both renderers agree on empty placeholder contract ────

  it('renderBarChart and renderLineChart both return SVG (not empty string) for []', () => {
    const bar  = renderBarChart([]);
    const line = renderLineChart([]);

    expect(bar).toContain('<svg');
    expect(line).toContain('<svg');
    expect(bar.length).toBeGreaterThan(0);
    expect(line.length).toBeGreaterThan(0);
  });

});
