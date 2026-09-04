// test/dashboard/memory-card.test.ts
// Unit tests for memory card rendering helpers (Task 6.4)
// Requirements: 2.5 (quality score badge), 2.10 (XSS prevention)

// MUST import setup first to initialize DOM and localStorage
import './memory-test-setup.js';

import { describe, it, expect } from 'bun:test';
import { renderMemoryCard } from '../../src/dashboard/pages/memory.js';
import type { Memory } from '../../src/dashboard/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const createMinimalMemory = (overrides?: Partial<Memory>): Memory => ({
  id: 'mem-123',
  text: 'Sample memory text',
  scope: {
    workspaceId: 'ws-1',
  },
  qualityScore: 0.75,
  createdAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
  lastRetrievedAt: new Date().toISOString(),
  retrievalCount: 0,
  tier: 'hot',
  embeddingStatus: 'ready',
  stale: false,
  superseded: false,
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// scoreClass Helper Tests (Quality Score Badge Mapping)
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreClass mapping (Requirement 2.5)', () => {
  it('should map score >= 0.85 to high class', () => {
    const memory = createMinimalMemory({ qualityScore: 0.85 });
    const html = renderMemoryCard(memory);
    expect(html).toContain('memory-card__score--high');
  });

  it('should map score 0.90 to high class', () => {
    const memory = createMinimalMemory({ qualityScore: 0.90 });
    const html = renderMemoryCard(memory);
    expect(html).toContain('memory-card__score--high');
  });

  it('should map score 1.0 to high class', () => {
    const memory = createMinimalMemory({ qualityScore: 1.0 });
    const html = renderMemoryCard(memory);
    expect(html).toContain('memory-card__score--high');
  });

  it('should map score 0.65 to medium class (boundary)', () => {
    const memory = createMinimalMemory({ qualityScore: 0.65 });
    const html = renderMemoryCard(memory);
    expect(html).toContain('memory-card__score--medium');
  });

  it('should map score 0.75 to medium class', () => {
    const memory = createMinimalMemory({ qualityScore: 0.75 });
    const html = renderMemoryCard(memory);
    expect(html).toContain('memory-card__score--medium');
  });

  it('should map score 0.84 to medium class (just below high threshold)', () => {
    const memory = createMinimalMemory({ qualityScore: 0.84 });
    const html = renderMemoryCard(memory);
    expect(html).toContain('memory-card__score--medium');
  });

  it('should map score 0.64 to low class (just below medium threshold)', () => {
    const memory = createMinimalMemory({ qualityScore: 0.64 });
    const html = renderMemoryCard(memory);
    expect(html).toContain('memory-card__score--low');
  });

  it('should map score 0.5 to low class', () => {
    const memory = createMinimalMemory({ qualityScore: 0.5 });
    const html = renderMemoryCard(memory);
    expect(html).toContain('memory-card__score--low');
  });

  it('should map score 0.0 to low class', () => {
    const memory = createMinimalMemory({ qualityScore: 0.0 });
    const html = renderMemoryCard(memory);
    expect(html).toContain('memory-card__score--low');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// XSS Prevention Tests (Requirement 2.10)
// ─────────────────────────────────────────────────────────────────────────────

describe('XSS prevention (Requirement 2.10)', () => {
  it('should escape HTML metacharacters in memory text', () => {
    const memory = createMinimalMemory({
      text: '<script>alert("xss")</script>',
    });
    const html = renderMemoryCard(memory);
    
    // The raw text should NOT appear verbatim
    expect(html).not.toContain('<script>alert("xss")</script>');
    
    // Escaped versions should be present
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;xss&quot;');
  });

  it('should escape < and > characters', () => {
    const memory = createMinimalMemory({
      text: 'Value < 5 and > 2',
    });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
    expect(html).not.toContain('Value < 5');
  });

  it('should escape & character', () => {
    const memory = createMinimalMemory({
      text: 'This & that',
    });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('&amp;');
  });

  it('should escape quotes in memory text', () => {
    const memory = createMinimalMemory({
      text: 'Text with "quotes" and \'apostrophes\'',
    });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
  });

  it('should escape memory ID in data attribute', () => {
    const memory = createMinimalMemory({
      id: 'mem-123"><script>alert("xss")</script><div data-id="',
    });
    const html = renderMemoryCard(memory);
    
    // The malicious ID should be escaped
    expect(html).not.toContain('"><script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('should escape workspaceId in scope pills', () => {
    const memory = createMinimalMemory({
      scope: {
        workspaceId: '<img src=x onerror=alert(1)>',
      },
    });
    const html = renderMemoryCard(memory);
    
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x');
  });

  it('should escape chainId in scope pills', () => {
    const memory = createMinimalMemory({
      scope: {
        workspaceId: 'ws-1',
        chainId: '<script>alert("chain")</script>',
      },
    });
    const html = renderMemoryCard(memory);
    
    expect(html).not.toContain('<script>alert("chain")</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('should escape all scope fields', () => {
    const memory = createMinimalMemory({
      scope: {
        workspaceId: '<ws>',
        chainId: '<chain>',
        agentId: '<agent>',
        runId: '<run>',
        userId: '<user>',
      },
    });
    const html = renderMemoryCard(memory);
    
    // None of the raw values should appear unescaped
    expect(html).not.toContain('<ws>');
    expect(html).not.toContain('<chain>');
    expect(html).not.toContain('<agent>');
    expect(html).not.toContain('<run>');
    expect(html).not.toContain('<user>');
    
    // All should be escaped
    const escapedCount = (html.match(/&lt;/g) || []).length;
    const closedCount = (html.match(/&gt;/g) || []).length;
    expect(escapedCount).toBeGreaterThanOrEqual(5);
    expect(closedCount).toBeGreaterThanOrEqual(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Text Clamping Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('text clamping', () => {
  it('should truncate text exceeding 200 characters', () => {
    const longText = 'a'.repeat(250);
    const memory = createMinimalMemory({ text: longText });
    const html = renderMemoryCard(memory);
    
    // Should contain ellipsis character
    expect(html).toContain('…');
    
    // Should NOT contain full untruncated text
    expect(html).not.toContain('a'.repeat(250));
  });

  it('should not truncate text under 200 characters', () => {
    const shortText = 'Short memory text';
    const memory = createMinimalMemory({ text: shortText });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain(shortText);
    expect(html).not.toContain('…');
  });

  it('should preserve text exactly at 200 characters', () => {
    const exactText = 'a'.repeat(200);
    const memory = createMinimalMemory({ text: exactText });
    const html = renderMemoryCard(memory);
    
    // Should NOT add ellipsis for text exactly at limit
    expect(html).not.toContain('…');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scope Pills Rendering Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('scope pills rendering', () => {
  it('should always render workspaceId pill', () => {
    const memory = createMinimalMemory({
      scope: { workspaceId: 'ws-test' },
    });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('ws:');
    expect(html).toContain('ws-test');
  });

  it('should render chainId pill when present', () => {
    const memory = createMinimalMemory({
      scope: {
        workspaceId: 'ws-1',
        chainId: 'chain-abc',
      },
    });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('chain:');
    expect(html).toContain('chain-abc');
  });

  it('should render agentId pill when present', () => {
    const memory = createMinimalMemory({
      scope: {
        workspaceId: 'ws-1',
        agentId: 'agent-xyz',
      },
    });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('agent:');
    expect(html).toContain('agent-xyz');
  });

  it('should render runId pill when present', () => {
    const memory = createMinimalMemory({
      scope: {
        workspaceId: 'ws-1',
        runId: 'run-123',
      },
    });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('run:');
    expect(html).toContain('run-123');
  });

  it('should render userId pill when present', () => {
    const memory = createMinimalMemory({
      scope: {
        workspaceId: 'ws-1',
        userId: 'user-456',
      },
    });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('user:');
    expect(html).toContain('user-456');
  });

  it('should render all scope pills when all fields present', () => {
    const memory = createMinimalMemory({
      scope: {
        workspaceId: 'ws-1',
        chainId: 'chain-1',
        agentId: 'agent-1',
        runId: 'run-1',
        userId: 'user-1',
      },
    });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('ws:');
    expect(html).toContain('chain:');
    expect(html).toContain('agent:');
    expect(html).toContain('run:');
    expect(html).toContain('user:');
  });

  it('should not render optional pills when fields absent', () => {
    const memory = createMinimalMemory({
      scope: { workspaceId: 'ws-1' },
    });
    const html = renderMemoryCard(memory);
    
    // Should only have workspace pill
    expect(html).toContain('ws:');
    
    // Should NOT have optional pills
    expect(html).not.toContain('chain:');
    expect(html).not.toContain('agent:');
    expect(html).not.toContain('run:');
    expect(html).not.toContain('user:');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Quality Score Badge Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('quality score badge', () => {
  it('should render score with 2 decimal places', () => {
    const memory = createMinimalMemory({ qualityScore: 0.856 });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('0.86');
  });

  it('should include aria-label with full precision', () => {
    const memory = createMinimalMemory({ qualityScore: 0.856 });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('aria-label="Quality score 0.86"');
  });

  it('should round score correctly', () => {
    const memory = createMinimalMemory({ qualityScore: 0.846 });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('0.85'); // Rounded up
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Relative Time Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('relative time formatting', () => {
  it('should format recent times in seconds', () => {
    const now = Date.now();
    const memory = createMinimalMemory({
      createdAt: new Date(now - 30000).toISOString(), // 30 seconds ago
    });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('30 seconds ago');
  });

  it('should format times in minutes', () => {
    const now = Date.now();
    const memory = createMinimalMemory({
      createdAt: new Date(now - 300000).toISOString(), // 5 minutes ago
    });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('5 minutes ago');
  });

  it('should format times in hours', () => {
    const now = Date.now();
    const memory = createMinimalMemory({
      createdAt: new Date(now - 7200000).toISOString(), // 2 hours ago
    });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('2 hours ago');
  });

  it('should include ISO datetime attribute', () => {
    const isoTime = '2024-03-15T14:05:09.000Z';
    const memory = createMinimalMemory({ createdAt: isoTime });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain(`datetime="${isoTime}"`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Action Buttons Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('action buttons', () => {
  it('should render Edit button with aria-label', () => {
    const memory = createMinimalMemory();
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('aria-label="Edit memory"');
    expect(html).toContain('data-action="edit"');
    expect(html).toContain('Edit');
    expect(html).toContain('</button>');
  });

  it('should render Delete button with aria-label', () => {
    const memory = createMinimalMemory();
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('aria-label="Delete memory"');
    expect(html).toContain('data-action="delete"');
    expect(html).toContain('Delete');
    expect(html).toContain('</button>');
  });

  it('should include data-action attributes for event delegation', () => {
    const memory = createMinimalMemory();
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('data-action="edit"');
    expect(html).toContain('data-action="delete"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Structural Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('card structure', () => {
  it('should render article element with data-memory-id', () => {
    const memory = createMinimalMemory({ id: 'mem-456' });
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('<article');
    expect(html).toContain('data-memory-id="mem-456"');
  });

  it('should have memory-card class', () => {
    const memory = createMinimalMemory();
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('class="memory-card"');
  });

  it('should contain all major sections', () => {
    const memory = createMinimalMemory();
    const html = renderMemoryCard(memory);
    
    expect(html).toContain('memory-card__body');
    expect(html).toContain('memory-card__text');
    expect(html).toContain('memory-card__meta');
    expect(html).toContain('memory-card__actions');
  });
});
