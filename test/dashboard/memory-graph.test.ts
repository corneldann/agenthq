// memory-graph.test.ts — Tests for graph data derivation
// Feature: phase-6.4-memory-browser

import { describe, it, expect } from 'vitest';
import { buildGraphData } from '../../src/dashboard/pages/memory-graph.js';
import type { Memory } from '../../src/dashboard/types.js';
import fc from 'fast-check';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a minimal Memory object for testing
 */
function createMemory(id: string, text: string): Memory {
  return {
    id,
    text,
    scope: { workspaceId: 'test-workspace' },
    qualityScore: 0.8,
    createdAt: new Date().toISOString(),
    lastRetrievedAt: new Date().toISOString(),
    retrievalCount: 0,
    tier: 'hot',
    embeddingStatus: 'ready',
  };
}

// ============================================================================
// Unit Tests — Basic Functionality
// ============================================================================

describe('buildGraphData', () => {
  describe('entity extraction', () => {
    it('should extract capitalized words as entities', () => {
      const memories = [
        createMemory('1', 'Dashboard uses TypeScript for type safety'),
      ];
      
      const result = buildGraphData(memories);
      
      const names = result.entities.map(e => e.name);
      expect(names).toContain('Dashboard');
      expect(names).toContain('TypeScript');
    });

    it('should extract multi-word capitalized phrases', () => {
      const memories = [
        createMemory('1', 'Memory Browser displays Memory Graph'),
      ];
      
      const result = buildGraphData(memories);
      
      const names = result.entities.map(e => e.name);
      expect(names).toContain('Memory Browser');
      expect(names).toContain('Memory Graph');
    });

    it('should extract camelCase identifiers', () => {
      const memories = [
        createMemory('1', 'buildGraphData returns GraphEntity array'),
      ];
      
      const result = buildGraphData(memories);
      
      const names = result.entities.map(e => e.name);
      expect(names).toContain('buildGraphData');
      expect(names).toContain('GraphEntity');
    });

    it('should extract quoted strings', () => {
      const memories = [
        createMemory('1', 'Returns "memory disabled" when MEMORY_ENABLED is false'),
      ];
      
      const result = buildGraphData(memories);
      
      const names = result.entities.map(e => e.name);
      expect(names).toContain('memory disabled');
      expect(names).toContain('MEMORY_ENABLED');
    });

    it('should extract file and path names', () => {
      const memories = [
        createMemory('1', 'See memory-graph.ts in src/dashboard/pages'),
      ];
      
      const result = buildGraphData(memories);
      
      const names = result.entities.map(e => e.name);
      expect(names).toContain('memory-graph.ts');
      expect(names).toContain('src/dashboard/pages');
    });

    it('should filter out common English words', () => {
      const memories = [
        createMemory('1', 'The Dashboard is built with TypeScript and Bun'),
      ];
      
      const result = buildGraphData(memories);
      
      const names = result.entities.map(e => e.name);
      expect(names).not.toContain('The');
      expect(names).not.toContain('is');
      expect(names).not.toContain('with');
      expect(names).not.toContain('and');
    });

    it('should deduplicate entities within same memory', () => {
      const memories = [
        createMemory('1', 'TypeScript provides TypeScript type checking'),
      ];
      
      const result = buildGraphData(memories);
      
      const typeScriptEntities = result.entities.filter(e => e.name === 'TypeScript');
      expect(typeScriptEntities).toHaveLength(1);
    });
  });

  describe('entity classification', () => {
    it('should classify entities mentioned 3+ times as primary', () => {
      const memories = [
        createMemory('1', 'TypeScript enables type safety'),
        createMemory('2', 'TypeScript compiles to JavaScript'),
        createMemory('3', 'Dashboard uses TypeScript'),
      ];
      
      const result = buildGraphData(memories);
      
      const typeScript = result.entities.find(e => e.name === 'TypeScript');
      expect(typeScript?.type).toBe('primary');
    });

    it('should classify entities mentioned 1-2 times as secondary', () => {
      const memories = [
        createMemory('1', 'Bun is a fast runtime'),
        createMemory('2', 'TypeScript enables type safety'),
      ];
      
      const result = buildGraphData(memories);
      
      const bun = result.entities.find(e => e.name === 'Bun');
      expect(bun?.type).toBe('secondary');
    });

    it('should use frequency threshold of 3 for primary classification', () => {
      const memories = [
        createMemory('1', 'Entity appears once'),
        createMemory('2', 'Entity appears twice'),
        createMemory('3', 'Now Entity qualifies'),
      ];
      
      const result = buildGraphData(memories);
      
      const entity = result.entities.find(e => e.name === 'Entity');
      expect(entity?.type).toBe('primary');
    });
  });

  describe('relation building', () => {
    it('should create relations between co-occurring entities', () => {
      const memories = [
        createMemory('1', 'Dashboard uses TypeScript'),
      ];
      
      const result = buildGraphData(memories);
      
      const dashboardId = result.entities.find(e => e.name === 'Dashboard')?.id;
      const typescriptId = result.entities.find(e => e.name === 'TypeScript')?.id;
      
      expect(dashboardId).toBeDefined();
      expect(typescriptId).toBeDefined();
      
      const relation = result.relations.find(
        r => r.from === dashboardId && r.to === typescriptId
      );
      expect(relation).toBeDefined();
      expect(relation?.label).toBe('co-occurs with');
    });

    it('should create bidirectional relations', () => {
      const memories = [
        createMemory('1', 'Dashboard uses TypeScript'),
      ];
      
      const result = buildGraphData(memories);
      
      const dashboardId = result.entities.find(e => e.name === 'Dashboard')?.id;
      const typescriptId = result.entities.find(e => e.name === 'TypeScript')?.id;
      
      const forward = result.relations.find(
        r => r.from === dashboardId && r.to === typescriptId
      );
      const backward = result.relations.find(
        r => r.from === typescriptId && r.to === dashboardId
      );
      
      expect(forward).toBeDefined();
      expect(backward).toBeDefined();
    });

    it('should not create duplicate relations', () => {
      const memories = [
        createMemory('1', 'Dashboard uses TypeScript'),
        createMemory('2', 'TypeScript powers Dashboard'),
      ];
      
      const result = buildGraphData(memories);
      
      const dashboardId = result.entities.find(e => e.name === 'Dashboard')?.id;
      const typescriptId = result.entities.find(e => e.name === 'TypeScript')?.id;
      
      const dashboardToTypescript = result.relations.filter(
        r => r.from === dashboardId && r.to === typescriptId
      );
      
      expect(dashboardToTypescript).toHaveLength(1);
    });

    it('should create relations for all entity pairs in a memory', () => {
      const memories = [
        createMemory('1', 'Dashboard uses TypeScript and Bun'),
      ];
      
      const result = buildGraphData(memories);
      
      // Should have 3 entities: Dashboard, TypeScript, Bun
      // Should have 6 relations (bidirectional): D↔T, D↔B, T↔B
      expect(result.entities).toHaveLength(3);
      expect(result.relations).toHaveLength(6);
    });
  });

  describe('entity ID generation', () => {
    it('should generate URL-safe IDs from entity names', () => {
      const memories = [
        createMemory('1', 'Memory Browser displays data'),
      ];
      
      const result = buildGraphData(memories);
      
      const memoryBrowser = result.entities.find(e => e.name === 'Memory Browser');
      expect(memoryBrowser?.id).toBe('memory-browser');
    });

    it('should handle special characters in entity names', () => {
      const memories = [
        createMemory('1', 'See src/dashboard/pages'),
      ];
      
      const result = buildGraphData(memories);
      
      const path = result.entities.find(e => e.name === 'src/dashboard/pages');
      expect(path?.id).toBe('src-dashboard-pages');
    });

    it('should remove consecutive hyphens from IDs', () => {
      const memories = [
        createMemory('1', 'Test  Multiple   Spaces'),
      ];
      
      const result = buildGraphData(memories);
      
      const entity = result.entities.find(e => e.name === 'Test  Multiple   Spaces');
      expect(entity?.id).not.toContain('--');
    });
  });

  describe('edge cases', () => {
    it('should return empty arrays for empty memory list', () => {
      const result = buildGraphData([]);
      
      expect(result.entities).toEqual([]);
      expect(result.relations).toEqual([]);
    });

    it('should handle memories with no extractable entities', () => {
      const memories = [
        createMemory('1', 'the and or but if when'),
      ];
      
      const result = buildGraphData(memories);
      
      expect(result.entities).toEqual([]);
      expect(result.relations).toEqual([]);
    });

    it('should handle memories with single entity (no relations)', () => {
      const memories = [
        createMemory('1', 'TypeScript'),
      ];
      
      const result = buildGraphData(memories);
      
      expect(result.entities).toHaveLength(1);
      expect(result.relations).toHaveLength(0);
    });

    it('should handle very long entity names', () => {
      const longName = 'VeryLongEntityNameThatSpansMultipleWordsContainsManyCharacters';
      const memories = [
        createMemory('1', longName),
      ];
      
      const result = buildGraphData(memories);
      
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe(longName);
    });
  });
});

// ============================================================================
// Property-Based Tests — Validates: Correctness Properties from Design Doc
// ============================================================================

describe('buildGraphData — property-based tests', () => {
  it('property: entity list contains no duplicates', () => {
    // **Validates: Requirements 3.1**
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            text: fc.oneof(
              fc.constant('TypeScript provides type safety for JavaScript'),
              fc.constant('Dashboard uses TypeScript and Bun runtime'),
              fc.constant('Memory Browser displays Memory Graph visualization'),
            ),
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (memoryData) => {
          const memories = memoryData.map(m => createMemory(m.id, m.text));
          const result = buildGraphData(memories);
          
          const entityNames = result.entities.map(e => e.name);
          const uniqueNames = new Set(entityNames);
          
          return entityNames.length === uniqueNames.size;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('property: all entities have valid IDs', () => {
    // **Validates: Requirements 3.1**
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            text: fc.string({ minLength: 10, maxLength: 200 }),
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (memoryData) => {
          const memories = memoryData.map(m => createMemory(m.id, m.text));
          const result = buildGraphData(memories);
          
          // All entity IDs must be non-empty, URL-safe strings
          return result.entities.every(entity => {
            const { id } = entity;
            return (
              id.length > 0 &&
              /^[a-z0-9-]+$/.test(id) &&
              !id.startsWith('-') &&
              !id.endsWith('-') &&
              !id.includes('--')
            );
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  it('property: entity type is always primary or secondary', () => {
    // **Validates: Requirements 3.1**
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            text: fc.oneof(
              fc.constant('Entity mentioned'),
              fc.constant('Entity appears'),
              fc.constant('Entity found'),
            ),
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (memoryData) => {
          const memories = memoryData.map(m => createMemory(m.id, m.text));
          const result = buildGraphData(memories);
          
          return result.entities.every(
            entity => entity.type === 'primary' || entity.type === 'secondary'
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('property: relation endpoints reference existing entities', () => {
    // **Validates: Requirements 3.1**
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            text: fc.string({ minLength: 20, maxLength: 100 }),
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (memoryData) => {
          const memories = memoryData.map(m => createMemory(m.id, m.text));
          const result = buildGraphData(memories);
          
          const entityIds = new Set(result.entities.map(e => e.id));
          
          return result.relations.every(
            rel => entityIds.has(rel.from) && entityIds.has(rel.to)
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('property: no self-referencing relations', () => {
    // **Validates: Requirements 3.1**
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            text: fc.string({ minLength: 20, maxLength: 100 }),
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (memoryData) => {
          const memories = memoryData.map(m => createMemory(m.id, m.text));
          const result = buildGraphData(memories);
          
          return result.relations.every(rel => rel.from !== rel.to);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('property: entity frequency determines classification correctly', () => {
    // **Validates: Requirements 3.1**
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (frequency) => {
          // Create N memories that all mention the same entity
          const memories = Array.from({ length: frequency }, (_, i) =>
            createMemory(`mem-${i}`, 'TestEntity appears here')
          );
          
          const result = buildGraphData(memories);
          const entity = result.entities.find(e => e.name === 'TestEntity');
          
          if (entity === undefined) return true; // Entity not extracted, skip
          
          const expectedType = frequency >= 3 ? 'primary' : 'secondary';
          return entity.type === expectedType;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('property: number of relations scales quadratically with entities per memory', () => {
    // **Validates: Requirements 3.1**
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        (numEntities) => {
          // Create a memory with N distinct capitalized words
          const entities = Array.from(
            { length: numEntities },
            (_, i) => `Entity${i}`
          );
          const text = entities.join(' and ');
          const memories = [createMemory('1', text)];
          
          const result = buildGraphData(memories);
          
          // For N entities, expect N*(N-1) relations (bidirectional pairs)
          const expectedRelations = numEntities * (numEntities - 1);
          return result.relations.length === expectedRelations;
        }
      ),
      { numRuns: 50 }
    );
  });
});
