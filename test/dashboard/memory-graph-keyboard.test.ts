// memory-graph-keyboard.test.ts — tests for keyboard navigation in memory graph
// Feature: phase-6.4-memory-browser, Task 12.2

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { 
  renderMemoryGraph, 
  attachFocusManagement, 
  buildRelationMapForGraph,
  type GraphEntity, 
  type GraphRelation 
} from '../../src/dashboard/pages/memory-graph.js';

describe('memory graph keyboard navigation (task 12.2)', () => {
  let window: Window;
  let document: Document;
  let container: HTMLElement;
  let cleanup: () => void;

  const testEntities: GraphEntity[] = [
    { id: 'entity-1', name: 'User', type: 'primary' },
    { id: 'entity-2', name: 'Session', type: 'secondary' },
    { id: 'entity-3', name: 'Memory', type: 'primary' },
  ];

  const testRelations: GraphRelation[] = [
    { from: 'entity-1', to: 'entity-2', label: 'has' },
    { from: 'entity-2', to: 'entity-3', label: 'contains' },
  ];

  beforeEach(() => {
    // Setup happy-dom environment
    window = new Window();
    // @ts-ignore - Happy-dom Document type is not fully compatible with DOM Document
    document = window.document;
    (global as any).document = document;
    (global as any).window = window;

    // Create container and mount graph
    container = document.createElement('div');
    container.innerHTML = renderMemoryGraph(testEntities, testRelations);
    document.body.appendChild(container);

    // Attach keyboard navigation
    const relationMap = buildRelationMapForGraph(testEntities, testRelations);
    cleanup = attachFocusManagement('memory-graph-svg', relationMap);
  });

  afterEach(() => {
    if (cleanup) {
      cleanup();
    }
    document.body.innerHTML = '';
    delete (global as any).document;
    delete (global as any).window;
  });

  describe('Enter key expand/collapse', () => {
    it('should set aria-expanded="true" when Enter is pressed on collapsed node', () => {
      const svg = document.getElementById('memory-graph-svg');
      expect(svg).not.toBeNull();

      // Get first node
      const firstNode = svg?.querySelector('[data-node-id="entity-1"]');
      expect(firstNode).not.toBeNull();
      expect(firstNode?.getAttribute('aria-expanded')).toBe('false');

      // Simulate Enter key press
      const event = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(event as unknown as Event);

      // Node should now be expanded
      expect(firstNode?.getAttribute('aria-expanded')).toBe('true');
    });


    it('should render tooltip when node is expanded', () => {
      const svg = document.getElementById('memory-graph-svg');
      expect(svg).not.toBeNull();

      const firstNode = svg?.querySelector('[data-node-id="entity-1"]') as SVGGElement;
      expect(firstNode).not.toBeNull();

      // Expand node with Enter
      const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent as unknown as Event);

      // Wait for tooltip to be rendered (synchronous in our implementation)
      const tooltip = firstNode?.querySelector('.memory-graph__tooltip-foreign');
      expect(tooltip).not.toBeNull();
    });

    it('should toggle aria-expanded="false" when Enter is pressed on expanded node', () => {
      const svg = document.getElementById('memory-graph-svg');
      const firstNode = svg?.querySelector('[data-node-id="entity-1"]') as SVGGElement;
      
      // First expand
      const enterEvent1 = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent1 as unknown as Event);
      expect(firstNode?.getAttribute('aria-expanded')).toBe('true');

      // Then collapse
      const enterEvent2 = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent2 as unknown as Event);
      expect(firstNode?.getAttribute('aria-expanded')).toBe('false');
    });

    it('should remove tooltip when node is collapsed', () => {
      const svg = document.getElementById('memory-graph-svg');
      const firstNode = svg?.querySelector('[data-node-id="entity-1"]') as SVGGElement;
      
      // Expand
      const enterEvent1 = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent1 as unknown as Event);
      expect(firstNode?.querySelector('.memory-graph__tooltip-foreign')).not.toBeNull();

      // Collapse
      const enterEvent2 = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent2 as unknown as Event);
      expect(firstNode?.querySelector('.memory-graph__tooltip-foreign')).toBeNull();
    });

    it('should display related entity names in tooltip', () => {
      const svg = document.getElementById('memory-graph-svg');
      const firstNode = svg?.querySelector('[data-node-id="entity-1"]') as SVGGElement;
      
      // Expand first node (User -> has Session)
      const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent as unknown as Event);

      const tooltip = firstNode?.querySelector('.memory-graph__tooltip');
      expect(tooltip).not.toBeNull();
      
      // Should contain relation label and target entity name
      const tooltipHTML = tooltip?.innerHTML || '';
      expect(tooltipHTML).toContain('has Session');
    });

    it('should display "No relations" when entity has no relations', () => {
      // Create a graph with an isolated node
      const isolatedEntities: GraphEntity[] = [
        { id: 'entity-1', name: 'Isolated', type: 'primary' },
        { id: 'entity-2', name: 'Entity2', type: 'secondary' },
        { id: 'entity-3', name: 'Entity3', type: 'primary' },
      ];
      const noRelations: GraphRelation[] = [];

      document.body.innerHTML = '';
      const newContainer = document.createElement('div');
      newContainer.innerHTML = renderMemoryGraph(isolatedEntities, noRelations);
      document.body.appendChild(newContainer);

      const relationMap = buildRelationMapForGraph(isolatedEntities, noRelations);
      const newCleanup = attachFocusManagement('memory-graph-svg', relationMap);

      const svg = document.getElementById('memory-graph-svg');
      const firstNode = svg?.querySelector('[data-node-id="entity-1"]') as SVGGElement;
      
      // Expand node
      const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent as unknown as Event);

      const tooltip = firstNode?.querySelector('.memory-graph__tooltip');
      expect(tooltip).not.toBeNull();
      expect(tooltip?.textContent).toContain('No relations');

      newCleanup();
    });
  });

  describe('Escape key collapse', () => {
    it('should collapse currently expanded node when Escape is pressed', () => {
      const svg = document.getElementById('memory-graph-svg');
      const firstNode = svg?.querySelector('[data-node-id="entity-1"]') as SVGGElement;
      
      // Expand node
      const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent as unknown as Event);
      expect(firstNode?.getAttribute('aria-expanded')).toBe('true');

      // Press Escape to collapse
      const escapeEvent = new window.KeyboardEvent('keydown', { key: 'Escape' });
      svg?.dispatchEvent(escapeEvent as unknown as Event);
      expect(firstNode?.getAttribute('aria-expanded')).toBe('false');
    });

    it('should remove tooltip when Escape is pressed', () => {
      const svg = document.getElementById('memory-graph-svg');
      const firstNode = svg?.querySelector('[data-node-id="entity-1"]') as SVGGElement;
      
      // Expand node
      const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent as unknown as Event);
      expect(firstNode?.querySelector('.memory-graph__tooltip-foreign')).not.toBeNull();

      // Press Escape
      const escapeEvent = new window.KeyboardEvent('keydown', { key: 'Escape' });
      svg?.dispatchEvent(escapeEvent as unknown as Event);
      expect(firstNode?.querySelector('.memory-graph__tooltip-foreign')).toBeNull();
    });

    it('should do nothing when Escape is pressed and no node is expanded', () => {
      const svg = document.getElementById('memory-graph-svg');
      const allNodes = svg?.querySelectorAll('[data-node-id]');
      
      // Verify all nodes are collapsed
      allNodes?.forEach(node => {
        expect(node.getAttribute('aria-expanded')).toBe('false');
      });

      // Press Escape (should not throw)
      const escapeEvent = new window.KeyboardEvent('keydown', { key: 'Escape' });
      svg?.dispatchEvent(escapeEvent as unknown as Event);

      // All nodes should still be collapsed
      allNodes?.forEach(node => {
        expect(node.getAttribute('aria-expanded')).toBe('false');
      });
    });

    it('should collapse any expanded node regardless of focus position', () => {
      const svg = document.getElementById('memory-graph-svg');
      const firstNode = svg?.querySelector('[data-node-id="entity-1"]') as SVGGElement;
      const secondNode = svg?.querySelector('[data-node-id="entity-2"]') as SVGGElement;
      
      // Expand first node
      const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent as unknown as Event);
      expect(firstNode?.getAttribute('aria-expanded')).toBe('true');

      // Move focus to second node with Tab
      const tabEvent = new window.KeyboardEvent('keydown', { key: 'Tab' });
      svg?.dispatchEvent(tabEvent as unknown as Event);

      // Press Escape - should collapse first node even though focus is on second
      const escapeEvent = new window.KeyboardEvent('keydown', { key: 'Escape' });
      svg?.dispatchEvent(escapeEvent as unknown as Event);
      expect(firstNode?.getAttribute('aria-expanded')).toBe('false');
    });
  });

  describe('tooltip positioning', () => {
    it('should position tooltip relative to node position', () => {
      const svg = document.getElementById('memory-graph-svg');
      const firstNode = svg?.querySelector('[data-node-id="entity-1"]') as SVGGElement;
      
      // Expand node
      const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent as unknown as Event);

      const foreignObject = firstNode?.querySelector('.memory-graph__tooltip-foreign');
      expect(foreignObject).not.toBeNull();

      // Check that x and y attributes are set
      const x = foreignObject?.getAttribute('x');
      const y = foreignObject?.getAttribute('y');
      expect(x).not.toBeNull();
      expect(y).not.toBeNull();
      
      // x and y should be numeric strings
      expect(isNaN(parseFloat(x || ''))).toBe(false);
      expect(isNaN(parseFloat(y || ''))).toBe(false);
    });

    it('should set reasonable width and height for tooltip', () => {
      const svg = document.getElementById('memory-graph-svg');
      const firstNode = svg?.querySelector('[data-node-id="entity-1"]') as SVGGElement;
      
      // Expand node
      const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent as unknown as Event);

      const foreignObject = firstNode?.querySelector('.memory-graph__tooltip-foreign');
      expect(foreignObject?.getAttribute('width')).toBe('200');
      expect(foreignObject?.getAttribute('height')).toBe('120');
    });
  });

  describe('tooltip content', () => {
    it('should include "Relations:" header in tooltip', () => {
      const svg = document.getElementById('memory-graph-svg');
      const firstNode = svg?.querySelector('[data-node-id="entity-1"]') as SVGGElement;
      
      // Expand node
      const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent as unknown as Event);

      const tooltip = firstNode?.querySelector('.memory-graph__tooltip');
      expect(tooltip?.textContent).toContain('Relations:');
    });

    it('should escape HTML in relation names', () => {
      // Create entities with HTML characters in names
      const xssEntities: GraphEntity[] = [
        { id: 'entity-1', name: 'User<script>', type: 'primary' },
        { id: 'entity-2', name: 'Session&Co', type: 'secondary' },
        { id: 'entity-3', name: 'Memory', type: 'primary' },
      ];
      const xssRelations: GraphRelation[] = [
        { from: 'entity-1', to: 'entity-2', label: 'has' },
      ];

      document.body.innerHTML = '';
      const newContainer = document.createElement('div');
      newContainer.innerHTML = renderMemoryGraph(xssEntities, xssRelations);
      document.body.appendChild(newContainer);

      const relationMap = buildRelationMapForGraph(xssEntities, xssRelations);
      const newCleanup = attachFocusManagement('memory-graph-svg', relationMap);

      const svg = document.getElementById('memory-graph-svg');
      const firstNode = svg?.querySelector('[data-node-id="entity-1"]') as SVGGElement;
      
      // Expand node
      const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent as unknown as Event);

      const tooltip = firstNode?.querySelector('.memory-graph__tooltip');
      const tooltipHTML = tooltip?.innerHTML || '';
      
      // HTML should be escaped
      expect(tooltipHTML).toContain('&amp;Co');
      expect(tooltipHTML).not.toContain('<script>');

      newCleanup();
    });

    it('should list all relations for an entity', () => {
      // Create entity with multiple relations
      const multiRelEntities: GraphEntity[] = [
        { id: 'entity-1', name: 'User', type: 'primary' },
        { id: 'entity-2', name: 'Session', type: 'secondary' },
        { id: 'entity-3', name: 'Memory', type: 'primary' },
        { id: 'entity-4', name: 'Token', type: 'secondary' },
      ];
      const multiRelations: GraphRelation[] = [
        { from: 'entity-1', to: 'entity-2', label: 'has' },
        { from: 'entity-1', to: 'entity-3', label: 'owns' },
        { from: 'entity-1', to: 'entity-4', label: 'uses' },
      ];

      document.body.innerHTML = '';
      const newContainer = document.createElement('div');
      newContainer.innerHTML = renderMemoryGraph(multiRelEntities, multiRelations);
      document.body.appendChild(newContainer);

      const relationMap = buildRelationMapForGraph(multiRelEntities, multiRelations);
      const newCleanup = attachFocusManagement('memory-graph-svg', relationMap);

      const svg = document.getElementById('memory-graph-svg');
      const firstNode = svg?.querySelector('[data-node-id="entity-1"]') as SVGGElement;
      
      // Expand node
      const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent as unknown as Event);

      const tooltip = firstNode?.querySelector('.memory-graph__tooltip');
      const tooltipText = tooltip?.textContent || '';
      
      // All relations should be listed
      expect(tooltipText).toContain('has Session');
      expect(tooltipText).toContain('owns Memory');
      expect(tooltipText).toContain('uses Token');

      newCleanup();
    });
  });

  describe('integration with Tab navigation', () => {
    it('should allow Enter on any focused node', () => {
      const svg = document.getElementById('memory-graph-svg');
      const nodes = svg?.querySelectorAll('[data-node-id]');
      expect(nodes?.length).toBeGreaterThan(1);

      // Tab to second node
      const tabEvent = new window.KeyboardEvent('keydown', { key: 'Tab' });
      svg?.dispatchEvent(tabEvent as unknown as Event);

      // Expand second node with Enter
      const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent as unknown as Event);

      const secondNode = nodes?.[1] as SVGGElement;
      expect(secondNode?.getAttribute('aria-expanded')).toBe('true');
    });

    it('should maintain focus when expanding/collapsing node', () => {
      const svg = document.getElementById('memory-graph-svg');
      const firstNode = svg?.querySelector('[data-node-id="entity-1"]') as SVGGElement;
      
      // Focus first node
      firstNode?.focus();
      expect(document.activeElement).toBe(firstNode);

      // Expand
      const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent as unknown as Event);
      expect(document.activeElement).toBe(firstNode);

      // Collapse
      const enterEvent2 = new window.KeyboardEvent('keydown', { key: 'Enter' });
      svg?.dispatchEvent(enterEvent2 as unknown as Event);
      expect(document.activeElement).toBe(firstNode);
    });
  });
});
