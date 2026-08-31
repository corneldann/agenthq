// memory-graph.ts — Graph data derivation from Memory objects
// Feature: phase-6.4-memory-browser

import type { Memory } from '../types.js';

/**
 * Entity extracted from memory text for graph visualization
 */
export type GraphEntity = {
  /** Unique identifier for the entity */
  id: string;
  /** Display name of the entity */
  name: string;
  /** Visual classification — primary entities appear as circles, secondary as diamonds */
  type: 'primary' | 'secondary';
};

/**
 * Relationship between two entities derived from co-occurrence in memories
 */
export type GraphRelation = {
  /** Source entity ID */
  from: string;
  /** Target entity ID */
  to: string;
  /** Relationship description */
  label: string;
};

/**
 * Graph data extracted from memory text
 */
export type GraphData = {
  entities: GraphEntity[];
  relations: GraphRelation[];
};

/**
 * Builds graph data from memory objects for visualization
 *
 * Extracts entity names mentioned in memory text and derives relationships from
 * entity co-occurrences within the same memory. This is a display-only approximation
 * — the authoritative relationship store is in the Hindsight MCP server.
 *
 * Entity classification:
 * - Primary: entities mentioned in 3+ memories (high frequency indicates importance)
 * - Secondary: entities mentioned in 1-2 memories
 *
 * Relations are derived from co-occurrence: when two entities appear in the same
 * memory text, a "co-occurs with" relation is created.
 *
 * @param memories - Array of Memory objects to extract graph data from
 * @returns Object containing unique entities and their relations
 *
 * @example
 * ```typescript
 * const memories = [
 *   { text: 'Dashboard uses TypeScript SPA', ... },
 *   { text: 'TypeScript enables type safety', ... }
 * ];
 * const graph = buildGraphData(memories);
 * // graph.entities includes 'Dashboard', 'TypeScript', 'SPA', 'type safety'
 * // graph.relations includes 'Dashboard' -> 'TypeScript', etc.
 * ```
 */
export function buildGraphData(memories: Memory[]): GraphData {
  // Phase 1: Extract all entity mentions with frequency tracking
  const entityFrequency = new Map<string, number>();
  const entityMemories = new Map<string, Set<string>>(); // entity -> memory IDs
  
  for (const memory of memories) {
    const entities = extractEntities(memory.text);
    for (const entity of entities) {
      entityFrequency.set(entity, (entityFrequency.get(entity) ?? 0) + 1);
      
      let memorySet = entityMemories.get(entity);
      if (memorySet === undefined) {
        memorySet = new Set<string>();
        entityMemories.set(entity, memorySet);
      }
      memorySet.add(memory.id);
    }
  }

  // Phase 2: Build unique entity list with type classification
  const entities: GraphEntity[] = [];
  for (const [name, frequency] of entityFrequency) {
    entities.push({
      id: nameToId(name),
      name,
      type: frequency >= 3 ? 'primary' : 'secondary',
    });
  }

  // Phase 3: Build relations from co-occurrences within same memory
  const relations: GraphRelation[] = [];
  const seenRelations = new Set<string>(); // track "from-to" pairs to avoid duplicates

  for (const memory of memories) {
    const entities = extractEntities(memory.text);
    
    // Create relations between all entity pairs in this memory
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const fromName = entities[i];
        const toName = entities[j];
        const fromId = nameToId(fromName);
        const toId = nameToId(toName);
        
        // Create bidirectional relation (A->B and B->A)
        const relation1 = `${fromId}-${toId}`;
        const relation2 = `${toId}-${fromId}`;
        
        if (!seenRelations.has(relation1)) {
          seenRelations.add(relation1);
          relations.push({
            from: fromId,
            to: toId,
            label: 'co-occurs with',
          });
        }
        
        if (!seenRelations.has(relation2)) {
          seenRelations.add(relation2);
          relations.push({
            from: toId,
            to: fromId,
            label: 'co-occurs with',
          });
        }
      }
    }
  }

  return { entities, relations };
}

/**
 * Extracts entity names from memory text
 *
 * Uses simple heuristics to identify entities:
 * - Capitalized words and phrases (e.g., "TypeScript", "Memory Browser")
 * - Technical terms in camelCase or PascalCase (e.g., "buildGraphData", "IMemoryClient")
 * - ALL_CAPS identifiers (e.g., "MEMORY_ENABLED")
 * - Quoted strings (e.g., "memory disabled")
 * - Module/file names (e.g., "memory-graph.ts", "src/dashboard")
 *
 * Filters out:
 * - Common English words (a, the, is, are, etc.)
 * - Single-letter words
 * - Pure numbers
 *
 * @param text - Memory text to extract entities from
 * @returns Array of unique entity names (deduplicated)
 */
function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  const capturedPositions = new Set<string>(); // Track "start-end" to avoid duplicates
  
  // Helper to mark a match position as captured
  const markCaptured = (match: string, index: number) => {
    for (let i = index; i < index + match.length; i++) {
      capturedPositions.add(String(i));
    }
  };
  
  // Helper to check if a position range is already captured
  const isAlreadyCaptured = (index: number, length: number): boolean => {
    for (let i = index; i < index + length; i++) {
      if (capturedPositions.has(String(i))) return true;
    }
    return false;
  };
  
  // Pattern 1: Multi-word capitalized phrases (e.g., "Memory Browser", "Circuit Breaker")
  // Process first to capture longest matches
  // Filter out phrases containing common words
  const phraseRegex = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;
  let match: RegExpExecArray | null;
  while ((match = phraseRegex.exec(text)) !== null) {
    const phrase = match[0];
    const words = phrase.split(/\s+/);
    const hasCommonWord = words.some(w => isCommonWord(w));
    
    if (!hasCommonWord) {
      entities.add(phrase);
      markCaptured(phrase, match.index);
    }
  }
  
  // Pattern 2: PascalCase identifiers (e.g., TypeScript, GraphEntity, IMemoryClient)
  // Requires at least one lowercase letter to avoid matching ALL_CAPS
  const pascalRegex = /\b[A-Z][a-z]+(?:[A-Z][a-zA-Z0-9]*)+/g;
  while ((match = pascalRegex.exec(text)) !== null) {
    if (!isAlreadyCaptured(match.index, match[0].length)) {
      entities.add(match[0]);
      markCaptured(match[0], match.index);
    }
  }
  
  // Pattern 3: Single capitalized words (including sentence starts, min 3 chars)
  // Skip if already captured as part of phrase or PascalCase
  // Also captures identifiers with trailing digits like "Entity0", "Test1"
  const wordRegex = /\b[A-Z][a-z]{2,}[0-9]*/g;
  while ((match = wordRegex.exec(text)) !== null) {
    const word = match[0];
    if (!isCommonWord(word) && !isAlreadyCaptured(match.index, word.length)) {
      entities.add(word);
      markCaptured(word, match.index);
    }
  }
  
  // Pattern 4: ALL_CAPS identifiers (e.g., MEMORY_ENABLED, SSE, API)
  const capsRegex = /\b[A-Z][A-Z_]{2,}\b/g;
  while ((match = capsRegex.exec(text)) !== null) {
    if (!isAlreadyCaptured(match.index, match[0].length)) {
      entities.add(match[0]);
      markCaptured(match[0], match.index);
    }
  }
  
  // Pattern 5: camelCase identifiers (e.g., buildGraphData, extractEntities)
  const camelRegex = /\b[a-z]+[A-Z][a-zA-Z0-9]*/g;
  while ((match = camelRegex.exec(text)) !== null) {
    if (!isAlreadyCaptured(match.index, match[0].length)) {
      entities.add(match[0]);
      markCaptured(match[0], match.index);
    }
  }
  
  // Pattern 6: Quoted strings (single or double quotes)
  const quotedRegex = /['"]([^'"]{3,})['"]/g;
  while ((match = quotedRegex.exec(text)) !== null) {
    // Check if the content inside quotes overlaps with already captured positions
    // The match[0] includes the quotes, match[1] is just the content
    const contentStart = match.index + 1; // +1 to skip opening quote
    const contentLength = match[1].length;
    
    if (!isAlreadyCaptured(contentStart, contentLength)) {
      // Extract the text between quotes (group 1) and trim whitespace
      const content = match[1].trim();
      if (content.length >= 3 && !isCommonWord(content)) {
        entities.add(content);
        // Mark the entire quoted string including quotes
        markCaptured(match[0], match.index);
      }
    }
  }
  
  // Pattern 7: File/module names (with extensions or paths)
  const fileRegex = /[a-z0-9-]+\.[a-z]{2,}|[a-z0-9-]+\/[a-z0-9-/]+/gi;
  while ((match = fileRegex.exec(text)) !== null) {
    if (!isAlreadyCaptured(match.index, match[0].length)) {
      entities.add(match[0]);
      markCaptured(match[0], match.index);
    }
  }
  
  return Array.from(entities);
}

/**
 * Checks if a word is a common English word that should be filtered out
 *
 * Common words add noise to the graph without providing semantic value.
 * This list is minimal — only the most frequent function words.
 *
 * @param word - Word to check
 * @returns True if the word should be filtered out
 */
function isCommonWord(word: string): boolean {
  const common = new Set([
    'The', 'A', 'An', 'And', 'Or', 'But', 'If', 'When', 'Where', 'Why',
    'How', 'What', 'Which', 'Who', 'This', 'That', 'These', 'Those',
    'It', 'Its', 'Is', 'Are', 'Was', 'Were', 'Be', 'Been', 'Being',
    'Have', 'Has', 'Had', 'Do', 'Does', 'Did', 'Will', 'Would', 'Should',
    'Can', 'Could', 'May', 'Might', 'Must', 'For', 'To', 'Of', 'In',
    'On', 'At', 'By', 'With', 'From', 'About', 'As', 'Into', 'Through',
    'During', 'Before', 'After', 'Above', 'Below', 'Between', 'Among',
    'Now', 'Then', 'Here', 'There',
  ]);
  
  return common.has(word);
}

/**
 * Converts an entity name to a stable ID suitable for use in HTML/SVG
 *
 * Generates a URL-safe identifier by:
 * - Lowercasing
 * - Replacing spaces and special chars with hyphens
 * - Removing consecutive hyphens
 * - Trimming leading/trailing hyphens
 *
 * @param name - Entity name to convert
 * @returns URL-safe identifier
 *
 * @example
 * ```typescript
 * nameToId('Memory Browser') // => 'memory-browser'
 * nameToId('IMemoryClient')  // => 'imemoryclient'
 * nameToId('src/dashboard')  // => 'src-dashboard'
 * ```
 */
function nameToId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
