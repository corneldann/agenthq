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
  // Requirement 3.1: SVG force-directed graph container (nodes/edges added in later tasks)
  const entityCount = entities.length;

  return `<div class="memory-graph">
  <svg class="memory-graph__svg" role="application" tabindex="0"
       aria-label="Memory knowledge graph with ${entityCount} entities"
       aria-describedby="memory-graph-table">
    <!-- nodes and edges will be added in later tasks -->
  </svg>
  <table class="sr-only" id="memory-graph-table" aria-label="Memory entity relationships">
    <caption>Memory knowledge graph entities and relationships</caption>
    <thead><tr><th>Entity</th><th>Relations</th></tr></thead>
    <tbody>
      <!-- rows will be added in later tasks -->
    </tbody>
  </table>
</div>`;
}
