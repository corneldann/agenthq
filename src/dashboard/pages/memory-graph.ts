// memory-graph.ts — SVG force-directed graph rendering for memory entities
// Feature: phase-6.4-memory-browser

import { esc } from '../utils.js';

/**
 * GraphEntity — represents a node in the memory knowledge graph.
 *
 * @property id - unique entity identifier
 * @property name - display name of the entity
 * @property type - visual classification (primary = circle, secondary = diamond)
 */
export type GraphEntity = {
  id: string;
  name: string;
  type: 'primary' | 'secondary';
};

/**
 * GraphRelation — represents a directed edge between two entities.
 *
 * @property from - source entity ID
 * @property to - target entity ID
 * @property label - relationship description
 */
export type GraphRelation = {
  from: string;
  to: string;
  label: string;
};

/**
 * renderEntityNode — renders a single entity node with dual encoding (shape + color).
 *
 * Primary nodes are rendered as circles with accent color fill.
 * Secondary nodes are rendered as diamonds (4-point polygon) with muted color fill.
 * Each node group includes:
 * - data-node-id attribute for keyboard navigation
 * - role="button" for accessibility
 * - aria-label describing the entity
 * - Text label with sufficient contrast (4.5:1 against SVG background)
 *
 * @param entity - the entity to render
 * @param x - horizontal center position
 * @param y - vertical center position
 * @returns SVG <g> element containing the node shape and label
 *
 * **Validates: Requirements 3.5, 3.6**
 */
function renderEntityNode(entity: GraphEntity, x: number, y: number): string {
  const isPrimary = entity.type === 'primary';

  // Requirement 3.5: Dual encoding via shape (circle vs diamond) and color
  const shapeHTML = isPrimary
    ? `<circle cx="${x}" cy="${y}" r="12" fill="var(--accent, #3b82f6)" />`
    : renderDiamond(x, y);

  // Requirement 3.6: Text labels with minimum 4.5:1 contrast
  // Using --text color (#e2e8f0) against --bg (#0f1117) = ~14:1 contrast ratio
  const labelY = y + 24; // Position label below the node

  return `<g data-node-id="${esc(entity.id)}" role="button" tabindex="0"
       aria-label="Entity: ${esc(entity.name)}" aria-expanded="false">
      ${shapeHTML}
      <text x="${x}" y="${labelY}" 
            text-anchor="middle" 
            fill="var(--text, #e2e8f0)" 
            font-size="11" 
            font-family="ui-monospace, monospace">
        ${esc(entity.name)}
      </text>
    </g>`;
}

/**
 * renderDiamond — renders a diamond shape (4-point polygon) for secondary nodes.
 *
 * @param cx - center x coordinate
 * @param cy - center y coordinate
 * @returns SVG <polygon> element forming a diamond shape
 */
function renderDiamond(cx: number, cy: number): string {
  // Diamond dimensions: 12px radius (same visual weight as circle r="12")
  const size = 12;
  const top = `${cx},${cy - size}`;
  const right = `${cx + size},${cy}`;
  const bottom = `${cx},${cy + size}`;
  const left = `${cx - size},${cy}`;

  return `<polygon points="${top} ${right} ${bottom} ${left}" 
                   fill="var(--muted, #6b7280)" />`;
}

/**
 * renderRelationEdge — renders a single relation edge between two entity nodes.
 *
 * Edges are rendered as SVG <line> elements connecting the source and target node
 * positions. All edges have aria-hidden="true" because the relationships are listed
 * in the sr-only table for screen reader accessibility.
 *
 * @param relation - the relation to render
 * @param entityPositions - map from entity ID to {x, y} coordinates
 * @returns SVG <line> element representing the edge, or empty string if positions not found
 *
 * **Validates: Requirement 3.1**
 */
function renderRelationEdge(
  relation: GraphRelation,
  entityPositions: Map<string, { x: number; y: number }>,
): string {
  const fromPos = entityPositions.get(relation.from);
  const toPos = entityPositions.get(relation.to);

  // Skip rendering if either entity position is missing
  if (!fromPos || !toPos) {
    return '';
  }

  // Requirement 3.1: Render edges with aria-hidden (screen readers use sr-only table)
  // Using subtle stroke color for edges that doesn't overpower the nodes
  return `<line x1="${fromPos.x}" y1="${fromPos.y}" 
             x2="${toPos.x}" y2="${toPos.y}" 
             stroke="var(--border, #2d3748)" 
             stroke-width="1.5" 
             stroke-opacity="0.5"
             aria-hidden="true" />`;
}

/**
 * buildRelationMap — builds a map of entity IDs to related entity names.
 *
 * For each entity, collects the names of all entities it has relations to or from.
 * Used to populate the sr-only table for screen reader accessibility.
 *
 * @param entities - array of all entities
 * @param relations - array of all relations
 * @returns map from entity ID to array of related entity names
 */
function buildRelationMap(
  entities: GraphEntity[],
  relations: GraphRelation[],
): Record<string, string[]> {
  const entityNameById = new Map<string, string>();
  for (const entity of entities) {
    entityNameById.set(entity.id, entity.name);
  }

  const result: Record<string, string[]> = {};

  for (const rel of relations) {
    // Add relation for source entity
    if (!result[rel.from]) result[rel.from] = [];
    const targetName = entityNameById.get(rel.to);
    if (targetName) {
      result[rel.from].push(`${rel.label} ${targetName}`);
    }

    // Add reverse relation for target entity (for screen reader completeness)
    if (!result[rel.to]) result[rel.to] = [];
    const sourceName = entityNameById.get(rel.from);
    if (sourceName) {
      result[rel.to].push(`${sourceName} ${rel.label} (this)`);
    }
  }

  return result;
}

/**
 * renderMemoryGraph — renders an SVG force-directed graph with accessibility support.
 *
 * When fewer than 3 entities are provided, renders an empty state container with
 * the message "Not enough data to display graph" to indicate insufficient data for
 * meaningful graph visualization.
 *
 * For valid data (≥3 entities), renders:
 * - An SVG container with role="application", tabindex="0", and descriptive aria-label
 * - A visually-hidden table (sr-only) for screen reader accessibility
 *
 * All dynamic text is escaped via esc() to prevent XSS injection.
 *
 * @param entities - array of entity nodes to display
 * @param relations - array of directed edges between entities
 * @returns HTML string containing the graph container
 *
 * @example
 * // Empty state (< 3 entities)
 * renderMemoryGraph([], [])
 * // => '<div class="memory-graph__empty" role="application" tabindex="0"
 * //      aria-label="Memory knowledge graph with 0 entities">
 * //      <p>Not enough data to display graph</p></div>'
 *
 * @example
 * // Valid graph (≥ 3 entities)
 * renderMemoryGraph(
 *   [
 *     { id: '1', name: 'User', type: 'primary' },
 *     { id: '2', name: 'Session', type: 'secondary' },
 *     { id: '3', name: 'Memory', type: 'primary' }
 *   ],
 *   [{ from: '1', to: '2', label: 'has' }]
 * )
 * // => '<div class="memory-graph">...</div>'
 *
 * **Validates: Requirements 3.1, 3.3, 3.7**
 */
/**
 * attachFocusManagement — attaches keyboard navigation handlers to graph nodes.
 *
 * Implements Tab/Shift+Tab navigation moving between nodes, Enter to expand/collapse
 * a node's relation tooltip, and Escape to collapse the currently expanded node.
 * Tracks the currently focused node in a closure variable. Should be called after
 * the graph SVG is mounted to the DOM.
 *
 * Focus management behavior:
 * - Tab: moves focus to next node in document order (forward)
 * - Shift+Tab: moves focus to previous node in document order (backward)
 * - Focus wraps around at boundaries (first ↔ last)
 * - Enter: toggles aria-expanded and renders/removes relation tooltip
 * - Escape: collapses active node (sets aria-expanded="false", removes tooltip)
 *
 * @param containerId - the ID of the SVG container element
 * @param relationsByEntityId - map from entity ID to array of related entity names with labels
 * @returns cleanup function that removes event listeners
 *
 * **Validates: Requirement 3.2**
 */
export function attachFocusManagement(
  containerId: string,
  relationsByEntityId: Record<string, string[]>,
): () => void {
  const container = document.getElementById(containerId);
  if (!container) {
    return () => {}; // No-op cleanup if container not found
  }

  // Get all node elements (querySelectorAll returns NodeList in document order)
  const nodes = Array.from(
    container.querySelectorAll<SVGGElement>('[data-node-id]'),
  );

  if (nodes.length === 0) {
    return () => {}; // No-op cleanup if no nodes
  }

  // Track currently focused node index
  let currentFocusIndex = 0;

  // Handler for keyboard navigation
  const handleKeyDown = (event: KeyboardEvent): void => {
    // Handle Tab key (with or without Shift modifier)
    if (event.key === 'Tab') {
      // Prevent default Tab behavior (moving focus to next tabbable element in page)
      event.preventDefault();

      // Determine direction
      const direction = event.shiftKey ? -1 : 1;

      // Calculate next index with wrapping
      currentFocusIndex = (currentFocusIndex + direction + nodes.length) % nodes.length;

      // Move focus to the target node
      nodes[currentFocusIndex].focus();
      return;
    }

    // Handle Enter key: toggle expand/collapse
    if (event.key === 'Enter') {
      event.preventDefault();

      const currentNode = nodes[currentFocusIndex];
      const nodeId = currentNode.getAttribute('data-node-id');
      const isExpanded = currentNode.getAttribute('aria-expanded') === 'true';

      if (isExpanded) {
        // Collapse: set aria-expanded="false" and remove tooltip
        currentNode.setAttribute('aria-expanded', 'false');
        removeTooltip(currentNode);
      } else {
        // Expand: set aria-expanded="true" and render tooltip
        currentNode.setAttribute('aria-expanded', 'true');
        if (nodeId) {
          renderTooltip(currentNode, nodeId, relationsByEntityId);
        }
      }
      return;
    }

    // Handle Escape key: collapse active node
    if (event.key === 'Escape') {
      event.preventDefault();

      // Find the currently expanded node (if any)
      const expandedNode = nodes.find(
        node => node.getAttribute('aria-expanded') === 'true',
      );

      if (expandedNode) {
        expandedNode.setAttribute('aria-expanded', 'false');
        removeTooltip(expandedNode);
      }
      return;
    }
  };

  // Attach keydown listener to container
  container.addEventListener('keydown', handleKeyDown);

  // Set initial focus to first node when container receives focus
  const handleContainerFocus = (): void => {
    if (document.activeElement !== container && !container.contains(document.activeElement)) {
      nodes[0].focus();
      currentFocusIndex = 0;
    }
  };

  container.addEventListener('focus', handleContainerFocus);

  // Track focus changes to update currentFocusIndex
  const handleFocusIn = (event: Event): void => {
    const target = event.target as Element;
    const nodeId = target.getAttribute('data-node-id');
    if (nodeId) {
      const index = nodes.findIndex(node => node.getAttribute('data-node-id') === nodeId);
      if (index !== -1) {
        currentFocusIndex = index;
      }
    }
  };

  container.addEventListener('focusin', handleFocusIn);

  // Return cleanup function
  return () => {
    container.removeEventListener('keydown', handleKeyDown);
    container.removeEventListener('focus', handleContainerFocus);
    container.removeEventListener('focusin', handleFocusIn);
  };
}

/**
 * renderTooltip — renders an inline relation tooltip for an expanded node.
 *
 * Uses SVG <foreignObject> to embed HTML content (a div with list of relations).
 * The tooltip is positioned relative to the node and contains related entity names
 * with their relation labels.
 *
 * @param nodeElement - the SVG <g> element representing the node
 * @param nodeId - the entity ID
 * @param relationsByEntityId - map from entity ID to array of related entity names with labels
 */
function renderTooltip(
  nodeElement: SVGGElement,
  nodeId: string,
  relationsByEntityId: Record<string, string[]>,
): void {
  const relations = relationsByEntityId[nodeId] || [];

  // If no relations, show "No relations" message
  const relationsHTML = relations.length > 0
    ? relations.map(rel => `<li>${esc(rel)}</li>`).join('')
    : '<li>No relations</li>';

  // Get node position from the <circle> or <polygon> element
  const shapeElement = nodeElement.querySelector('circle, polygon');
  if (!shapeElement) {
    return; // Cannot position tooltip without shape element
  }

  let x = 0;
  let y = 0;

  if (shapeElement.tagName === 'circle') {
    const circle = shapeElement as SVGCircleElement;
    x = parseFloat(circle.getAttribute('cx') || '0');
    y = parseFloat(circle.getAttribute('cy') || '0');
  } else if (shapeElement.tagName === 'polygon') {
    // For diamond, parse the points attribute to get center
    const points = shapeElement.getAttribute('points') || '';
    const coords = points.split(' ').map(p => p.split(',').map(Number));
    if (coords.length >= 4) {
      // Average the x and y coordinates to get center
      x = coords.reduce((sum, [px]) => sum + px, 0) / coords.length;
      y = coords.reduce((sum, [, py]) => sum + py, 0) / coords.length;
    }
  }

  // Position tooltip to the right of the node with some offset
  const tooltipX = x + 20;
  const tooltipY = y - 40; // Position above center

  // Create foreignObject for HTML content
  const foreignObject = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
  foreignObject.setAttribute('x', String(tooltipX));
  foreignObject.setAttribute('y', String(tooltipY));
  foreignObject.setAttribute('width', '200');
  foreignObject.setAttribute('height', '120');
  foreignObject.setAttribute('class', 'memory-graph__tooltip-foreign');

  // Create HTML content
  const tooltipDiv = document.createElement('div');
  tooltipDiv.className = 'memory-graph__tooltip';
  tooltipDiv.innerHTML = `
    <div class="memory-graph__tooltip-content">
      <strong>Relations:</strong>
      <ul>${relationsHTML}</ul>
    </div>
  `;

  foreignObject.appendChild(tooltipDiv);
  nodeElement.appendChild(foreignObject);
}

/**
 * removeTooltip — removes the inline relation tooltip from a node.
 *
 * @param nodeElement - the SVG <g> element representing the node
 */
function removeTooltip(nodeElement: SVGGElement): void {
  const tooltip = nodeElement.querySelector('.memory-graph__tooltip-foreign');
  if (tooltip) {
    tooltip.remove();
  }
}

/**
 * buildRelationMapForGraph — builds relation map for use in keyboard navigation tooltips.
 *
 * This is a public helper that allows the consumer (memory.ts) to compute the relation
 * map once and pass it to both renderMemoryGraph and attachFocusManagement, avoiding
 * duplicate computation.
 *
 * @param entities - array of all entities
 * @param relations - array of all relations
 * @returns map from entity ID to array of related entity names with labels
 */
export function buildRelationMapForGraph(
  entities: GraphEntity[],
  relations: GraphRelation[],
): Record<string, string[]> {
  return buildRelationMap(entities, relations);
}

export function renderMemoryGraph(
  entities: GraphEntity[],
  relations: GraphRelation[],
): string {
  // Requirement 3.7: Render empty state when fewer than 3 entities
  if (entities.length < 3) {
    return `<div class="memory-graph__empty" role="application" tabindex="0"
     aria-label="Memory knowledge graph with ${entities.length} entities">
  <p>Not enough data to display graph</p>
</div>`;
  }

  // Requirement 3.3: SVG container with role, tabindex, and entity-count aria-label
  // Requirement 3.1: SVG force-directed graph with entity nodes
  const entityCount = entities.length;

  // Simple circular layout for nodes (force-directed physics will be added in task 12)
  const centerX = 300;
  const centerY = 200;
  const radius = 120;
  const angleStep = (2 * Math.PI) / entities.length;

  // Build entity position map for edge rendering
  const entityPositions = new Map<string, { x: number; y: number }>();
  entities.forEach((entity, index) => {
    const angle = index * angleStep;
    const x = centerX + radius * Math.cos(angle);
    const y = centerY + radius * Math.sin(angle);
    entityPositions.set(entity.id, { x, y });
  });

  // Render relation edges (before nodes so nodes appear on top)
  const edgesHTML = relations.map(relation => 
    renderRelationEdge(relation, entityPositions)
  ).filter(edge => edge !== '').join('\n    ');

  // Render entity nodes with dual encoding (shape + color)
  const nodesHTML = entities.map((entity, index) => {
    const angle = index * angleStep;
    const x = centerX + radius * Math.cos(angle);
    const y = centerY + radius * Math.sin(angle);

    return renderEntityNode(entity, x, y);
  }).join('\n    ');

  // Build sr-only table rows
  const relationsByEntity = buildRelationMap(entities, relations);
  const tableRowsHTML = entities.map(entity => {
    const relatedNames = relationsByEntity[entity.id] || [];
    return `<tr>
        <td>${esc(entity.name)}</td>
        <td>${relatedNames.map(esc).join(', ')}</td>
      </tr>`;
  }).join('\n      ');

  return `<div class="memory-graph">
  <svg id="memory-graph-svg" class="memory-graph__svg" role="application" tabindex="0"
       aria-label="Memory knowledge graph with ${entityCount} entities"
       aria-describedby="memory-graph-table"
       viewBox="0 0 600 400"
       xmlns="http://www.w3.org/2000/svg">
    ${edgesHTML}
    ${nodesHTML}
  </svg>
  <table class="sr-only" id="memory-graph-table" aria-label="Memory entity relationships">
    <caption>Memory knowledge graph entities and relationships</caption>
    <thead><tr><th>Entity</th><th>Relations</th></tr></thead>
    <tbody>
      ${tableRowsHTML}
    </tbody>
  </table>
</div>`;
}
