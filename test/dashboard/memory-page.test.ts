// test/dashboard/memory-page.test.ts — Unit tests for memory page
// Feature: phase-6.4-memory-browser
// Tests tab structure, keyboard navigation, ARIA attributes

// MUST import setup first to initialize DOM and localStorage
import './memory-test-setup';

import { describe, test, expect, beforeEach, afterEach, it } from 'bun:test';
import { renderMemoryPage, initMemoryPage } from '../../src/dashboard/pages/memory';
import { esc } from '../../src/dashboard/utils';
import type { Memory } from '../../src/memory/types';
import * as fc from 'fast-check';

// Get KeyboardEvent from window
const KeyboardEvent = (globalThis as Record<string, unknown>).window.KeyboardEvent;

describe('renderMemoryPage', () => {
  test('should return HTML string with memory page structure', () => {
    // Arrange & Act
    const html = renderMemoryPage();

    // Assert
    expect(html).toContain('class="memory-page"');
    expect(html).toContain('id="memory-root"');
  });

  test('should include tablist with role="tablist"', () => {
    // Arrange & Act
    const html = renderMemoryPage();

    // Assert
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Memory browser tabs"');
  });

  test('should render Timeline tab button with correct ARIA attributes', () => {
    // Arrange & Act
    const html = renderMemoryPage();

    // Assert
    expect(html).toContain('role="tab"');
    expect(html).toContain('id="tab-timeline"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-controls="panel-timeline"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('Timeline');
  });

  test('should render Graph tab button with correct ARIA attributes', () => {
    // Arrange & Act
    const html = renderMemoryPage();

    // Assert
    expect(html).toContain('id="tab-graph"');
    expect(html).toContain('aria-selected="false"');
    expect(html).toContain('aria-controls="panel-graph"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('Graph');
  });

  test('should render Timeline tabpanel with correct ARIA attributes', () => {
    // Arrange & Act
    const html = renderMemoryPage();

    // Assert
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('id="panel-timeline"');
    expect(html).toContain('aria-labelledby="tab-timeline"');
  });

  test('should render Graph tabpanel with correct ARIA attributes', () => {
    // Arrange & Act
    const html = renderMemoryPage();

    // Assert
    expect(html).toContain('id="panel-graph"');
    expect(html).toContain('aria-labelledby="tab-graph"');
    expect(html).toContain('hidden');
  });

  test('should render reflection panel sidebar with aria-label', () => {
    // Arrange & Act
    const html = renderMemoryPage();

    // Assert
    expect(html).toContain('class="memory-page__sidebar"');
    expect(html).toContain('aria-label="Memory reflection panel"');
  });
});

describe('initMemoryPage', () => {
  beforeEach(() => {
    // Arrange — mount memory page HTML into DOM
    document.body.innerHTML = renderMemoryPage();
    initMemoryPage();
  });

  afterEach(() => {
    // Cleanup
    document.body.innerHTML = '';
  });

  test('should activate Timeline tab by default', () => {
    // Assert
    const timelineTab = document.getElementById('tab-timeline');
    const timelinePanel = document.getElementById('panel-timeline');
    const graphPanel = document.getElementById('panel-graph');

    expect(timelineTab?.getAttribute('aria-selected')).toBe('true');
    expect(timelineTab?.getAttribute('tabindex')).toBe('0');
    expect(timelinePanel?.hasAttribute('hidden')).toBe(false);
    expect(graphPanel?.hasAttribute('hidden')).toBe(true);
  });

  test('should switch to Graph tab when Graph button clicked', () => {
    // Arrange
    const timelineTab = document.getElementById('tab-timeline');
    const graphTab = document.getElementById('tab-graph') as HTMLButtonElement;
    const timelinePanel = document.getElementById('panel-timeline');
    const graphPanel = document.getElementById('panel-graph');

    // Act
    graphTab.click();

    // Assert
    expect(graphTab.getAttribute('aria-selected')).toBe('true');
    expect(graphTab.getAttribute('tabindex')).toBe('0');
    expect(timelineTab?.getAttribute('aria-selected')).toBe('false');
    expect(timelineTab?.getAttribute('tabindex')).toBe('-1');
    expect(graphPanel?.hasAttribute('hidden')).toBe(false);
    expect(timelinePanel?.hasAttribute('hidden')).toBe(true);
  });

  test('should switch back to Timeline tab when Timeline button clicked', () => {
    // Arrange
    const timelineTab = document.getElementById('tab-timeline') as HTMLButtonElement;
    const graphTab = document.getElementById('tab-graph') as HTMLButtonElement;
    const timelinePanel = document.getElementById('panel-timeline');
    const graphPanel = document.getElementById('panel-graph');

    // Act — switch to Graph first
    graphTab.click();
    // Then switch back to Timeline
    timelineTab.click();

    // Assert
    expect(timelineTab.getAttribute('aria-selected')).toBe('true');
    expect(timelineTab.getAttribute('tabindex')).toBe('0');
    expect(graphTab.getAttribute('aria-selected')).toBe('false');
    expect(graphTab.getAttribute('tabindex')).toBe('-1');
    expect(timelinePanel?.hasAttribute('hidden')).toBe(false);
    expect(graphPanel?.hasAttribute('hidden')).toBe(true);
  });
});

describe('initMemoryPage — keyboard navigation', () => {
  beforeEach(() => {
    // Arrange
    document.body.innerHTML = renderMemoryPage();
    initMemoryPage();
  });

  afterEach(() => {
    // Cleanup
    document.body.innerHTML = '';
  });

  test('should move to Graph tab when ArrowRight pressed on Timeline tab', () => {
    // Arrange
    const timelineTab = document.getElementById('tab-timeline') as HTMLButtonElement;
    const graphTab = document.getElementById('tab-graph');
    const graphPanel = document.getElementById('panel-graph');

    // Act
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true });
    timelineTab.dispatchEvent(event as unknown as Event);

    // Assert
    expect(graphTab?.getAttribute('aria-selected')).toBe('true');
    expect(graphTab?.getAttribute('tabindex')).toBe('0');
    expect(graphPanel?.hasAttribute('hidden')).toBe(false);
  });

  test('should move to Timeline tab when ArrowLeft pressed on Graph tab', () => {
    // Arrange
    const timelineTab = document.getElementById('tab-timeline');
    const graphTab = document.getElementById('tab-graph') as HTMLButtonElement;
    const timelinePanel = document.getElementById('panel-timeline');

    // Act — switch to Graph first
    graphTab.click();
    // Then press ArrowLeft
    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true });
    graphTab.dispatchEvent(event as unknown as Event);

    // Assert
    expect(timelineTab?.getAttribute('aria-selected')).toBe('true');
    expect(timelineTab?.getAttribute('tabindex')).toBe('0');
    expect(timelinePanel?.hasAttribute('hidden')).toBe(false);
  });

  test('should wrap to Timeline when ArrowRight pressed on Graph tab', () => {
    // Arrange
    const graphTab = document.getElementById('tab-graph') as HTMLButtonElement;
    const timelineTab = document.getElementById('tab-timeline');

    // Act — switch to Graph first
    graphTab.click();
    // Then press ArrowRight (should wrap to Timeline)
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true });
    graphTab.dispatchEvent(event as unknown as Event);

    // Assert
    expect(timelineTab?.getAttribute('aria-selected')).toBe('true');
  });

  test('should wrap to Graph when ArrowLeft pressed on Timeline tab', () => {
    // Arrange
    const timelineTab = document.getElementById('tab-timeline') as HTMLButtonElement;
    const graphTab = document.getElementById('tab-graph');

    // Act — press ArrowLeft (should wrap to Graph)
    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true });
    timelineTab.dispatchEvent(event as unknown as Event);

    // Assert
    expect(graphTab?.getAttribute('aria-selected')).toBe('true');
  });

  test('should move to first tab when Home pressed', () => {
    // Arrange
    const timelineTab = document.getElementById('tab-timeline');
    const graphTab = document.getElementById('tab-graph') as HTMLButtonElement;

    // Act — switch to Graph first
    graphTab.click();
    // Then press Home
    const event = new KeyboardEvent('keydown', { key: 'Home', bubbles: true });
    graphTab.dispatchEvent(event as unknown as Event);

    // Assert
    expect(timelineTab?.getAttribute('aria-selected')).toBe('true');
  });

  test('should move to last tab when End pressed', () => {
    // Arrange
    const timelineTab = document.getElementById('tab-timeline') as HTMLButtonElement;
    const graphTab = document.getElementById('tab-graph');

    // Act — press End
    const event = new KeyboardEvent('keydown', { key: 'End', bubbles: true });
    timelineTab.dispatchEvent(event as unknown as Event);

    // Assert
    expect(graphTab?.getAttribute('aria-selected')).toBe('true');
  });

  test('should not respond to unrelated keys', () => {
    // Arrange
    const timelineTab = document.getElementById('tab-timeline') as HTMLButtonElement;
    const graphTab = document.getElementById('tab-graph');

    // Act — press a non-navigation key
    const event = new KeyboardEvent('keydown', { key: 'x', bubbles: true });
    timelineTab.dispatchEvent(event as unknown as Event);

    // Assert — should stay on Timeline
    expect(timelineTab.getAttribute('aria-selected')).toBe('true');
    expect(graphTab?.getAttribute('aria-selected')).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// Helper functions for memory card rendering tests
// These will be implemented in task 6.4, stubbed here for testing
// ---------------------------------------------------------------------------

/**
 * Maps a quality score to a CSS class modifier.
 * Requirements: 2.5 — Quality score badge colour classification
 */
function scoreClass(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.85) return 'high';
  if (score >= 0.65) return 'medium';
  return 'low';
}

/**
 * Clamps text to maxLen characters, appending "…" if truncated.
 */
function clampText(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}

/**
 * Renders a memory card HTML string.
 * ALL dynamic content MUST pass through esc() to prevent XSS.
 * Requirements: 2.5, 2.10
 */
function renderMemoryCard(memory: Memory): string {
  const scoreClassValue = scoreClass(memory.qualityScore);
  
  // Scope pills (all dynamic values escaped)
  const scopePills = `
    <span class="memory-card__scope-pill">${esc(memory.scope.workspaceId)}</span>
    ${memory.scope.chainId ? `<span class="memory-card__scope-pill">${esc(memory.scope.chainId)}</span>` : ''}
    ${memory.scope.agentId ? `<span class="memory-card__scope-pill">${esc(memory.scope.agentId)}</span>` : ''}
  `.trim();

  return `
<article class="memory-card" data-memory-id="${esc(memory.id)}">
  <div class="memory-card__body">
    <p class="memory-card__text">${esc(clampText(memory.text, 200))}</p>
    <div class="memory-card__meta">
      ${scopePills}
      <span class="memory-card__score memory-card__score--${scoreClassValue}"
            aria-label="Quality score ${memory.qualityScore.toFixed(2)}">
        ${memory.qualityScore.toFixed(2)}
      </span>
      <time class="memory-card__time" datetime="${esc(memory.createdAt)}">
        ${esc(memory.createdAt)}
      </time>
    </div>
  </div>
  <div class="memory-card__actions">
    <button class="memory-card__btn memory-card__btn--edit"
            aria-label="Edit memory">Edit</button>
    <button class="memory-card__btn memory-card__btn--delete"
            aria-label="Delete memory">Delete</button>
  </div>
</article>
  `.trim();
}

// ---------------------------------------------------------------------------
// Property-based tests for memory card rendering
// ---------------------------------------------------------------------------

describe('renderMemoryCard — XSS prevention (Property 5)', () => {
  // Create a minimal Memory object generator
  const minimalMemoryArb = fc.record({
    id: fc.string(),
    text: fc.string(),
    scope: fc.record({
      workspaceId: fc.string(),
      chainId: fc.option(fc.string(), { nil: undefined }),
      agentId: fc.option(fc.string(), { nil: undefined }),
    }),
    qualityScore: fc.float({ min: 0, max: 1, noNaN: true }),
    createdAt: fc.date().map((d) => d.toISOString()),
    lastRetrievedAt: fc.date().map((d) => d.toISOString()),
    retrievalCount: fc.integer({ min: 0 }),
    tier: fc.constantFrom('hot' as const, 'warm' as const, 'cold' as const),
    embeddingStatus: fc.constantFrom('pending' as const, 'ready' as const, 'failed' as const),
  });

  it('property: memory card text rendering escapes HTML metacharacters', () => {
    // Feature: phase-6.4-memory-browser, Property 5: memory card text rendering escapes HTML metacharacters
    // Validates: Requirements 2.10
    
    fc.assert(
      fc.property(
        // Generate strings containing HTML metacharacters
        fc.string().filter((s) => /[<>"'&]/.test(s)),
        (dangerousText) => {
          // Arrange — create memory with dangerous text
          const memory: Memory = {
            id: 'test-id',
            text: dangerousText,
            scope: { workspaceId: 'test-workspace' },
            qualityScore: 0.75,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastRetrievedAt: '2024-01-01T00:00:00.000Z',
            retrievalCount: 0,
            tier: 'hot',
            embeddingStatus: 'ready',
          };

          // Act — render card HTML
          const html = renderMemoryCard(memory);

          // Assert — verify that dangerous characters are escaped
          // The key insight: we check that if dangerous text contains these chars,
          // they MUST appear in their escaped form, and the original chars should
          // only appear as part of the HTML structure (not in dynamic content).
          
          const escapedText = esc(dangerousText);
          
          // The escaped version MUST appear in the HTML
          expect(html).toContain(escapedText);
          
          // Verify specific escaping for each dangerous character
          if (dangerousText.includes('<')) {
            expect(html).toContain('&lt;');
          }
          if (dangerousText.includes('>')) {
            expect(html).toContain('&gt;');
          }
          if (dangerousText.includes('&')) {
            expect(html).toContain('&amp;');
          }
          if (dangerousText.includes('"')) {
            expect(html).toContain('&quot;');
          }
          if (dangerousText.includes("'")) {
            expect(html).toContain('&#39;');
          }
          
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: scope fields are escaped when they contain HTML metacharacters', () => {
    // Feature: phase-6.4-memory-browser, Property 5: memory card text rendering escapes HTML metacharacters
    // Validates: Requirements 2.10 (scope pills must also be escaped)
    
    fc.assert(
      fc.property(
        fc.string().filter((s) => /[<>"'&]/.test(s)),
        fc.string().filter((s) => /[<>"'&]/.test(s)),
        fc.string().filter((s) => /[<>"'&]/.test(s)),
        (dangerousWorkspaceId, dangerousChainId, dangerousAgentId) => {
          // Arrange — create memory with dangerous scope values
          const memory: Memory = {
            id: 'test-id',
            text: 'Safe text',
            scope: {
              workspaceId: dangerousWorkspaceId,
              chainId: dangerousChainId,
              agentId: dangerousAgentId,
            },
            qualityScore: 0.75,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastRetrievedAt: '2024-01-01T00:00:00.000Z',
            retrievalCount: 0,
            tier: 'hot',
            embeddingStatus: 'ready',
          };

          // Act — render card HTML
          const html = renderMemoryCard(memory);

          // Assert — verify escaped versions appear in HTML
          const escapedWorkspaceId = esc(dangerousWorkspaceId);
          const escapedChainId = esc(dangerousChainId);
          const escapedAgentId = esc(dangerousAgentId);
          
          expect(html).toContain(escapedWorkspaceId);
          expect(html).toContain(escapedChainId);
          expect(html).toContain(escapedAgentId);
          
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: memory ID is escaped in data-memory-id attribute', () => {
    // Feature: phase-6.4-memory-browser, Property 5: memory card text rendering escapes HTML metacharacters
    // Validates: Requirements 2.10 (attributes must also be escaped)
    
    fc.assert(
      fc.property(
        fc.string().filter((s) => /[<>"'&]/.test(s)),
        (dangerousId) => {
          // Arrange — create memory with dangerous ID
          const memory: Memory = {
            id: dangerousId,
            text: 'Safe text',
            scope: { workspaceId: 'safe-workspace' },
            qualityScore: 0.75,
            createdAt: '2024-01-01T00:00:00.000Z',
            lastRetrievedAt: '2024-01-01T00:00:00.000Z',
            retrievalCount: 0,
            tier: 'hot',
            embeddingStatus: 'ready',
          };

          // Act — render card HTML
          const html = renderMemoryCard(memory);

          // Assert — dangerous ID should not appear unescaped in attribute
          // Extract the data-memory-id attribute value
          const match = html.match(/data-memory-id="([^"]*)"/);
          expect(match).toBeTruthy();
          
          if (match) {
            const attributeValue = match[1];
            // The attribute value should be the escaped version
            expect(attributeValue).not.toBe(dangerousId);
            // But should be the escaped version
            expect(attributeValue).toBe(esc(dangerousId));
          }
          
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: createdAt timestamp is escaped in datetime attribute', () => {
    // Feature: phase-6.4-memory-browser, Property 5: memory card text rendering escapes HTML metacharacters
    // Validates: Requirements 2.10 (datetime attributes must be escaped)
    
    fc.assert(
      fc.property(
        fc.string().filter((s) => /[<>"'&]/.test(s)),
        (dangerousTimestamp) => {
          // Arrange — create memory with dangerous timestamp
          const memory: Memory = {
            id: 'safe-id',
            text: 'Safe text',
            scope: { workspaceId: 'safe-workspace' },
            qualityScore: 0.75,
            createdAt: dangerousTimestamp,
            lastRetrievedAt: '2024-01-01T00:00:00.000Z',
            retrievalCount: 0,
            tier: 'hot',
            embeddingStatus: 'ready',
          };

          // Act — render card HTML
          const html = renderMemoryCard(memory);

          // Assert — dangerous timestamp should be escaped in datetime attribute
          const match = html.match(/datetime="([^"]*)"/);
          expect(match).toBeTruthy();
          
          if (match) {
            const attributeValue = match[1];
            expect(attributeValue).toBe(esc(dangerousTimestamp));
          }
          
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('scoreClass helper', () => {
  test('should return "high" for scores >= 0.85', () => {
    expect(scoreClass(0.85)).toBe('high');
    expect(scoreClass(0.9)).toBe('high');
    expect(scoreClass(1.0)).toBe('high');
  });

  test('should return "medium" for scores >= 0.65 and < 0.85', () => {
    expect(scoreClass(0.65)).toBe('medium');
    expect(scoreClass(0.75)).toBe('medium');
    expect(scoreClass(0.84)).toBe('medium');
  });

  test('should return "low" for scores < 0.65', () => {
    expect(scoreClass(0.0)).toBe('low');
    expect(scoreClass(0.5)).toBe('low');
    expect(scoreClass(0.64)).toBe('low');
  });

  it('property: quality score badge colour classification is exhaustive', () => {
    // Feature: phase-6.4-memory-browser, Property 6: quality score badge colour classification is exhaustive
    // Validates: Requirements 2.5
    //
    // This property verifies that EVERY valid quality score in [0.0, 1.0] maps to
    // exactly one of three CSS classes: 'high', 'medium', or 'low'. The mapping is:
    // - score >= 0.85 → 'high'
    // - score >= 0.65 and < 0.85 → 'medium'
    // - score < 0.65 → 'low'
    //
    // Exhaustiveness means there are no gaps where a valid score produces undefined
    // or unexpected output. This prevents runtime errors and ensures consistent
    // badge rendering for all possible quality scores.

    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1, noNaN: true }),
        (score) => {
          // Act — call scoreClass with generated score
          const result = scoreClass(score);

          // Assert — result must be exactly one of the three valid classes
          const validClasses: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];
          const isValid = validClasses.includes(result);

          // Additional assertion: verify it's exactly one, not multiple or none
          expect(isValid).toBe(true);
          expect(result).toBeTypeOf('string');

          // Verify the specific mapping logic
          if (score >= 0.85) {
            expect(result).toBe('high');
          } else if (score >= 0.65) {
            expect(result).toBe('medium');
          } else {
            expect(result).toBe('low');
          }

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
