// memory-graph.test.ts — tests for memory graph rendering
// Feature: phase-6.4-memory-browser

import { describe, it, expect } from 'bun:test';
import { renderMemoryGraph } from '../../src/dashboard/pages/memory-graph.js';
import type { GraphEntity, GraphRelation } from '../../src/dashboard/pages/memory-graph.js';
import * as fc from 'fast-check';

describe('renderMemoryGraph', () => {
  describe('empty state guard (< 3 entities)', () => {
    it('should render empty state for 0 entities', () => {
      const html = renderMemoryGraph([], []);

      expect(html).toContain('memory-graph__empty');
      expect(html).toContain('role="application"');
      expect(html).toContain('tabindex="0"');
      expect(html).toContain('aria-label="Memory knowledge graph with 0 entities"');
      expect(html).toContain('Not enough data to display graph');
    });

    it('should render empty state for 1 entity', () => {
      const entities: GraphEntity[] = [
        { id: '1', name: 'Entity1', type: 'primary' },
      ];
      const html = renderMemoryGraph(entities, []);

      expect(html).toContain('memory-graph__empty');
      expect(html).toContain('aria-label="Memory knowledge graph with 1 entities"');
      expect(html).toContain('Not enough data to display graph');
    });

    it('should render empty state for 2 entities', () => {
      const entities: GraphEntity[] = [
        { id: '1', name: 'Entity1', type: 'primary' },
        { id: '2', name: 'Entity2', type: 'secondary' },
      ];
      const html = renderMemoryGraph(entities, []);

      expect(html).toContain('memory-graph__empty');
      expect(html).toContain('aria-label="Memory knowledge graph with 2 entities"');
      expect(html).toContain('Not enough data to display graph');
    });
  });

  describe('valid graph rendering (≥ 3 entities)', () => {
    it('should render SVG container for 3 entities', () => {
      const entities: GraphEntity[] = [
        { id: '1', name: 'Entity1', type: 'primary' },
        { id: '2', name: 'Entity2', type: 'secondary' },
        { id: '3', name: 'Entity3', type: 'primary' },
      ];
      const html = renderMemoryGraph(entities, []);

      expect(html).toContain('<svg');
      expect(html).toContain('memory-graph__svg');
      expect(html).toContain('role="application"');
      expect(html).toContain('tabindex="0"');
      expect(html).toContain('aria-label="Memory knowledge graph with 3 entities"');
      expect(html).toContain('aria-describedby="memory-graph-table"');
    });

    it('should render sr-only table structure', () => {
      const entities: GraphEntity[] = [
        { id: '1', name: 'Entity1', type: 'primary' },
        { id: '2', name: 'Entity2', type: 'secondary' },
        { id: '3', name: 'Entity3', type: 'primary' },
      ];
      const html = renderMemoryGraph(entities, []);

      expect(html).toContain('<table class="sr-only"');
      expect(html).toContain('id="memory-graph-table"');
      expect(html).toContain('aria-label="Memory entity relationships"');
      expect(html).toContain('<caption>Memory knowledge graph entities and relationships</caption>');
      expect(html).toContain('<thead><tr><th>Entity</th><th>Relations</th></tr></thead>');
      expect(html).toContain('<tbody>');
    });

    it('should render correct entity count in aria-label for 5 entities', () => {
      const entities: GraphEntity[] = [
        { id: '1', name: 'E1', type: 'primary' },
        { id: '2', name: 'E2', type: 'secondary' },
        { id: '3', name: 'E3', type: 'primary' },
        { id: '4', name: 'E4', type: 'secondary' },
        { id: '5', name: 'E5', type: 'primary' },
      ];
      const html = renderMemoryGraph(entities, []);

      expect(html).toContain('aria-label="Memory knowledge graph with 5 entities"');
    });

    it('should not render empty state message for valid graph', () => {
      const entities: GraphEntity[] = [
        { id: '1', name: 'E1', type: 'primary' },
        { id: '2', name: 'E2', type: 'secondary' },
        { id: '3', name: 'E3', type: 'primary' },
      ];
      const html = renderMemoryGraph(entities, []);

      expect(html).not.toContain('Not enough data to display graph');
      expect(html).not.toContain('memory-graph__empty');
    });
  });

  describe('accessibility attributes', () => {
    it('should include role=application on empty state', () => {
      const html = renderMemoryGraph([], []);
      expect(html).toContain('role="application"');
    });

    it('should include tabindex=0 on empty state', () => {
      const html = renderMemoryGraph([], []);
      expect(html).toContain('tabindex="0"');
    });

    it('should include role=application on SVG container', () => {
      const entities: GraphEntity[] = [
        { id: '1', name: 'E1', type: 'primary' },
        { id: '2', name: 'E2', type: 'secondary' },
        { id: '3', name: 'E3', type: 'primary' },
      ];
      const html = renderMemoryGraph(entities, []);
      expect(html).toContain('role="application"');
      expect(html).toContain('class="memory-graph__svg"');
    });

    it('should include tabindex=0 on SVG container', () => {
      const entities: GraphEntity[] = [
        { id: '1', name: 'E1', type: 'primary' },
        { id: '2', name: 'E2', type: 'secondary' },
        { id: '3', name: 'E3', type: 'primary' },
      ];
      const html = renderMemoryGraph(entities, []);
      expect(html).toContain('tabindex="0"');
    });
  });

  describe('property-based tests', () => {
    it('property: aria-label reflects entity count accurately', () => {
      // Feature: phase-6.4-memory-browser
      // Property 7: graph aria-label reflects entity count accurately
      // **Validates: Requirements 3.3**
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              id: fc.uuid(),
              name: fc.string(),
              type: fc.constantFrom('primary' as const, 'secondary' as const),
            }),
            { minLength: 0, maxLength: 20 },
          ),
          (entities) => {
            const html = renderMemoryGraph(entities, []);
            const expectedText = `with ${entities.length} entities`;
            return html.includes(expectedText);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('property: empty state rendered when entity count < 3', () => {
      // Feature: phase-6.4-memory-browser
      // **Validates: Requirements 3.7**
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              id: fc.uuid(),
              name: fc.string(),
              type: fc.constantFrom('primary' as const, 'secondary' as const),
            }),
            { minLength: 0, maxLength: 2 },
          ),
          (entities) => {
            const html = renderMemoryGraph(entities, []);
            return (
              html.includes('memory-graph__empty') &&
              html.includes('Not enough data to display graph')
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('property: SVG container rendered when entity count >= 3', () => {
      // Feature: phase-6.4-memory-browser
      // **Validates: Requirements 3.1, 3.3**
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              id: fc.uuid(),
              name: fc.string(),
              type: fc.constantFrom('primary' as const, 'secondary' as const),
            }),
            { minLength: 3, maxLength: 20 },
          ),
          (entities) => {
            const html = renderMemoryGraph(entities, []);
            return (
              html.includes('<svg') &&
              html.includes('memory-graph__svg') &&
              html.includes('role="application"') &&
              html.includes('tabindex="0"') &&
              !html.includes('memory-graph__empty')
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('property: sr-only table always present in valid graphs', () => {
      // Feature: phase-6.4-memory-browser
      // **Validates: Requirements 3.4**
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              id: fc.uuid(),
              name: fc.string(),
              type: fc.constantFrom('primary' as const, 'secondary' as const),
            }),
            { minLength: 3, maxLength: 20 },
          ),
          (entities) => {
            const html = renderMemoryGraph(entities, []);
            return (
              html.includes('<table class="sr-only"') &&
              html.includes('id="memory-graph-table"') &&
              html.includes('<caption>Memory knowledge graph entities and relationships</caption>')
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('property: sr-only table contains all entity names and relations', () => {
      // Feature: phase-6.4-memory-browser, Property 8: sr-only table contains all entity names and relations
      // **Validates: Requirements 3.4**
      //
      // This property verifies that the sr-only accessibility table:
      // 1. Contains exactly one row for each entity (no entities are omitted)
      // 2. Contains all relations involving each entity in its relations column
      // 3. Properly escapes entity names to prevent XSS
      //
      // The sr-only table is critical for screen reader accessibility — it provides
      // the same information as the visual graph in a table format.

      fc.assert(
        fc.property(
          // Generate array of entities with unique IDs and names
          fc.array(
            fc.record({
              id: fc.uuid(),
              name: fc.string({ minLength: 1, maxLength: 30 }),
              type: fc.constantFrom('primary' as const, 'secondary' as const),
            }),
            { minLength: 3, maxLength: 15 },
          ),
          // Generate array of relations between the entities
          fc.array(
            fc.record({
              from: fc.uuid(),
              to: fc.uuid(),
              label: fc.stringMatching(/^(has|contains|relates-to|depends-on)$/),
            }),
            { maxLength: 20 },
          ),
          (entities, relations) => {
            // Import esc utility for verification
            const esc = (s: string): string => {
              return s
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
            };

            // Act — render the graph
            const html = renderMemoryGraph(entities, relations);

            // Parse the HTML to extract table structure
            const tableStartIndex = html.indexOf('<tbody>');
            const tableEndIndex = html.indexOf('</tbody>');
            
            if (tableStartIndex === -1 || tableEndIndex === -1) {
              // Table body is missing — property fails
              return false;
            }

            const tableBodyHTML = html.substring(tableStartIndex + 7, tableEndIndex);

            // Property 1: Verify every entity name appears exactly once in the table
            for (const entity of entities) {
              const escapedName = esc(entity.name);
              
              // Count occurrences of the entity name in the first column (entity name column)
              // Use a regex to match <td>entityName</td> pattern
              const entityNamePattern = new RegExp(`<td>${escapedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</td>`, 'g');
              const matches = tableBodyHTML.match(entityNamePattern);
              
              // Each entity should appear exactly once
              if (!matches || matches.length !== 1) {
                return false;
              }
            }

            // Property 2: Verify all relations involving each entity appear in its row
            // Build a map of expected relations per entity (matching the implementation logic)
            const entityNameById = new Map<string, string>();
            for (const entity of entities) {
              entityNameById.set(entity.id, entity.name);
            }

            const expectedRelationsByEntity: Record<string, string[]> = {};

            for (const rel of relations) {
              // Skip relations with non-existent entities (invalid relations)
              const targetName = entityNameById.get(rel.to);
              const sourceName = entityNameById.get(rel.from);
              
              if (!targetName || !sourceName) {
                continue;
              }

              // Add outgoing relation for source entity
              if (!expectedRelationsByEntity[rel.from]) {
                expectedRelationsByEntity[rel.from] = [];
              }
              expectedRelationsByEntity[rel.from].push(`${rel.label} ${targetName}`);

              // Add incoming relation for target entity
              if (!expectedRelationsByEntity[rel.to]) {
                expectedRelationsByEntity[rel.to] = [];
              }
              expectedRelationsByEntity[rel.to].push(`${sourceName} ${rel.label} (this)`);
            }

            // Verify each entity's relations appear in the table
            for (const entity of entities) {
              const escapedName = esc(entity.name);
              const expectedRelations = expectedRelationsByEntity[entity.id] || [];

              // Find the row for this entity
              const rowPattern = new RegExp(
                `<tr>\\s*<td>${escapedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</td>\\s*<td>([^<]*)</td>\\s*</tr>`,
                's'
              );
              const rowMatch = tableBodyHTML.match(rowPattern);

              if (!rowMatch) {
                // Row not found for this entity
                return false;
              }

              const relationsCellContent = rowMatch[1];

              // Verify all expected relations appear in the relations cell
              for (const expectedRelation of expectedRelations) {
                const escapedRelation = esc(expectedRelation);
                
                if (!relationsCellContent.includes(escapedRelation)) {
                  // Expected relation is missing
                  return false;
                }
              }
            }

            // All properties verified
            return true;
          },
        ),
        { numRuns: 100 },
      );
    });

  });
});
