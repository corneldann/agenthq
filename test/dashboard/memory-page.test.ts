// test/dashboard/memory-page.test.ts — Unit tests for memory page
// Feature: phase-6.4-memory-browser
// Tests tab structure, keyboard navigation, ARIA attributes

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { renderMemoryPage, initMemoryPage } from '../../src/dashboard/pages/memory';

// Mock DOM environment for tests (happy-dom provides document/window)
import { Window } from 'happy-dom';
const window = new Window();
global.document = window.document as unknown as Document;
const KeyboardEvent = window.KeyboardEvent;

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
