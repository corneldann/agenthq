/**
 * Property-Based Tests for Memory Export Format Serializers
 * 
 * Tests universal correctness properties for JSON, Markdown, and CSV export
 * formats using fast-check to generate arbitrary Memory objects.
 * 
 * Properties tested:
 *   1. JSON export completeness — all Memory fields present with correct types
 *   2. Markdown export format compliance — required sections present
 *   3. CSV RFC 4180 compliance — proper escaping, CRLF line endings
 *   4. Export omitted count accuracy — malformed records tracked correctly
 * 
 * **Feature:** phase-6.5-export-advanced
 * **Validates: Requirements 1.2, 1.3, 1.4, 1.6**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { exportMemories, type ExportMetadata } from '../../src/memory/export.js';
import type { DbAdapter, DbMemoryExtraction } from '../../src/db/adapter.js';
import type { Memory } from '../../src/memory/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Mock database adapter that returns predefined rows.
 */
function createMockDb(rows: DbMemoryExtraction[]): DbAdapter {
  return {
    query: async <T>(sql: string, params?: unknown[]) => {
      const [, limit, offset] = params ?? [];
      const start = (offset as number) ?? 0;
      const end = start + ((limit as number) ?? rows.length);
      return {
        rows: rows.slice(start, end) as unknown as T[],
        rowCount: Math.min(rows.length - start, (limit as number) ?? rows.length),
      };
    },
    execute: async () => ({ rowsAffected: 0 }),
    transaction: async () => {},
    close: async () => {},
  } as DbAdapter;
}

/**
 * Collect all chunks from async generator into a single string.
 */
async function collectChunks(generator: AsyncGenerator<string>): Promise<string> {
  let result = '';
  for await (const chunk of generator) {
    result += chunk;
  }
  return result;
}

// ---------------------------------------------------------------------------
// fast-check Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generate arbitrary Memory objects for property-based testing.
 * 
 * Injects special characters in text field ~30% of the time to test
 * CSV escaping logic (commas, quotes, newlines, carriage returns).
 */
function memoryArbitrary(): fc.Arbitrary<Memory> {
  return fc.record({
    id: fc.uuid().map(id => id.substring(0, 8)), // Shorter IDs for readability
    text: fc.string({ minLength: 1, maxLength: 500 }).chain(s => {
      // 30% chance: inject special characters to test escaping
      return fc.constantFrom(
        s,
        s + ',',
        s + '"',
        s + '\n',
        s + '\r',
        s + ',"test"',
        `Line 1\nLine 2\n${s}`,
      );
    }),
    scope: fc.record({
      workspaceId: fc.uuid(),
      chainId: fc.option(fc.uuid(), { nil: undefined }),
    }),
    qualityScore: fc.double({ min: 0, max: 1, noNaN: true }),
    createdAt: fc.integer({ min: 1577836800000, max: 1767225600000 }) // 2020-01-01 to 2026-01-01
      .map(ts => new Date(ts).toISOString()),
    lastRetrievedAt: fc.integer({ min: 1577836800000, max: 1767225600000 })
      .map(ts => new Date(ts).toISOString()),
    retrievalCount: fc.nat({ max: 10000 }),
    tier: fc.constantFrom('hot', 'warm', 'cold'),
    embeddingStatus: fc.constantFrom('pending', 'ready', 'failed'),
    stale: fc.boolean(),
    superseded: fc.boolean(),
  });
}

/**
 * Generate arbitrary DbMemoryExtraction rows from Memory objects.
 */
function dbRowArbitrary(): fc.Arbitrary<DbMemoryExtraction> {
  return memoryArbitrary().map(memory => ({
    id: parseInt(memory.id.replace(/-/g, '').substring(0, 8), 16), // Convert to number
    job_id: memory.scope.chainId ?? '',
    workspace_id: memory.scope.workspaceId,
    extracted_at: memory.createdAt,
    raw_text: memory.text,
    memory_count: 1,
    quality_score: memory.qualityScore,
    embedding_status: memory.embeddingStatus === 'ready' ? 'embedded' : memory.embeddingStatus,
    embed_attempts: 1,
    tier: memory.tier === 'warm' ? 'cold' : memory.tier, // DB schema only has hot/cold
    last_modified: Date.now(),
    deleted_at: null,
    stale: memory.stale ? 1 : 0,
    superseded: memory.superseded ? 1 : 0,
    last_retrieved_at: memory.lastRetrievedAt,
    retrieval_count: memory.retrievalCount,
  }));
}

// ---------------------------------------------------------------------------
// Property 1: JSON Export Completeness
// ---------------------------------------------------------------------------

describe('Property 1: JSON Export Completeness', () => {
  it('property: every exported Memory in JSON format SHALL contain all required fields with correct types', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(dbRowArbitrary(), { minLength: 1, maxLength: 50 }).filter(arr => arr.length > 0),
        async (dbRows) => {
          // Arrange
          const db = createMockDb(dbRows);
          const metadata: ExportMetadata = { omittedCount: 0 };

          // Act
          const output = await collectChunks(
            exportMemories(db, 'test-workspace', 'json', metadata)
          );

          // Assert: parse as JSON
          const parsed = JSON.parse(output);
          expect(Array.isArray(parsed)).toBe(true);
          expect(parsed.length).toBe(dbRows.length);

          // Assert: every element has all required Memory fields
          for (const memory of parsed) {
            // Required fields exist
            expect(memory).toHaveProperty('id');
            expect(memory).toHaveProperty('text');
            expect(memory).toHaveProperty('scope');
            expect(memory).toHaveProperty('qualityScore');
            expect(memory).toHaveProperty('createdAt');
            expect(memory).toHaveProperty('lastRetrievedAt');
            expect(memory).toHaveProperty('retrievalCount');
            expect(memory).toHaveProperty('tier');
            expect(memory).toHaveProperty('embeddingStatus');
            expect(memory).toHaveProperty('stale');
            expect(memory).toHaveProperty('superseded');

            // Nested scope fields
            expect(memory.scope).toHaveProperty('workspaceId');
            expect(memory.scope).toHaveProperty('chainId');

            // Type checks
            expect(typeof memory.id).toBe('string');
            expect(typeof memory.text).toBe('string');
            expect(memory.text.length).toBeGreaterThan(0);
            expect(typeof memory.scope.workspaceId).toBe('string');
            expect(typeof memory.qualityScore).toBe('number');
            expect(typeof memory.createdAt).toBe('string');
            expect(typeof memory.lastRetrievedAt).toBe('string');
            expect(typeof memory.retrievalCount).toBe('number');
            expect(['hot', 'warm', 'cold']).toContain(memory.tier);
            expect(['pending', 'ready', 'failed']).toContain(memory.embeddingStatus);
            expect(typeof memory.stale).toBe('boolean');
            expect(typeof memory.superseded).toBe('boolean');

            // ISO 8601 date format validation (basic check)
            expect(memory.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(memory.lastRetrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Markdown Export Format Compliance
// ---------------------------------------------------------------------------

describe('Property 2: Markdown Export Format Compliance', () => {
  it('property: every exported Memory in Markdown format SHALL contain required sections', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(dbRowArbitrary(), { minLength: 1, maxLength: 20 }),
        async (dbRows) => {
          // Arrange
          const db = createMockDb(dbRows);
          const metadata: ExportMetadata = { omittedCount: 0 };

          // Act
          const output = await collectChunks(
            exportMemories(db, 'test-workspace', 'markdown', metadata)
          );

          // Assert: header present
          expect(output).toContain('# Memory Export');

          // Assert: each memory has required sections
          const memorySections = output.split('## Memory').slice(1); // Skip before first ##
          expect(memorySections.length).toBe(dbRows.length);

          for (let i = 0; i < memorySections.length; i++) {
            const section = memorySections[i];
            const dbRow = dbRows[i];

            // Required markdown sections
            expect(section).toContain('**ID**:');
            expect(section).toContain('**Text**:');
            expect(section).toContain('**Workspace**:');
            expect(section).toContain('**Chain**:');
            expect(section).toContain('**Quality Score**:');
            expect(section).toContain('**Created**:');
            expect(section).toContain('**Last Retrieved**:');
            expect(section).toContain('**Retrieval Count**:');
            expect(section).toContain('**Tier**:');
            expect(section).toContain('**Status**:');
            expect(section).toContain('**Stale**:');
            expect(section).toContain('**Superseded**:');

            // Verify actual values appear in section
            expect(section).toContain(dbRow.workspace_id);
            expect(section).toContain(dbRow.extracted_at);
            expect(section).toContain(dbRow.tier);

            // Quality score formatted to 4 decimal places
            const qualityStr = dbRow.quality_score.toFixed(4);
            expect(section).toContain(qualityStr);

            // ISO 8601 date format (basic check)
            expect(section).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

            // Stale and superseded as Yes/No
            const staleText = dbRow.stale === 1 ? 'Yes' : 'No';
            const supersededText = dbRow.superseded === 1 ? 'Yes' : 'No';
            expect(section).toContain(`**Stale**: ${staleText}`);
            expect(section).toContain(`**Superseded**: ${supersededText}`);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: CSV RFC 4180 Compliance
// ---------------------------------------------------------------------------

describe('Property 3: CSV RFC 4180 Compliance', () => {
  it('property: every exported CSV SHALL be RFC 4180 compliant with proper escaping and CRLF line endings', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(dbRowArbitrary(), { minLength: 1, maxLength: 50 }),
        async (dbRows) => {
          // Arrange
          const db = createMockDb(dbRows);
          const metadata: ExportMetadata = { omittedCount: 0 };

          // Act
          const output = await collectChunks(
            exportMemories(db, 'test-workspace', 'csv', metadata)
          );

          // Assert: CRLF line endings (RFC 4180)
          const lines = output.split('\r\n');
          expect(lines.length).toBeGreaterThan(dbRows.length); // header + data rows + empty line

          // Assert: header row present
          const header = lines[0];
          expect(header).toBe(
            'id,text,workspaceId,chainId,qualityScore,createdAt,tier,embeddingStatus,stale,superseded,lastRetrievedAt,retrievalCount'
          );

          // Assert: each data row has correct field count
          const fieldCount = header.split(',').length;
          for (let i = 1; i <= dbRows.length; i++) {
            const line = lines[i];
            const fields = parseCSVLine(line);
            expect(fields.length).toBe(fieldCount);
          }

          // Assert: fields with special characters are properly quoted and escaped
          for (let i = 0; i < dbRows.length; i++) {
            const dbRow = dbRows[i];
            const line = lines[i + 1];

            // If text contains comma, quote, newline, or CR, it must be quoted
            if (
              dbRow.raw_text.includes(',') ||
              dbRow.raw_text.includes('"') ||
              dbRow.raw_text.includes('\n') ||
              dbRow.raw_text.includes('\r')
            ) {
              // Field should be quoted
              expect(line).toMatch(/"[^"]*"/);
            }

            // If text contains double quotes, they must be escaped as ""
            if (dbRow.raw_text.includes('"')) {
              expect(line).toContain('""');
            }

            // Boolean fields (stale, superseded) should be 0 or 1
            expect(line).toMatch(/,[01],[01],/);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('property: CSV fields containing commas SHALL be quoted', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(
          dbRowArbitrary().map(row => ({
            ...row,
            raw_text: row.raw_text + ',comma'  // Force comma injection
          })),
          { minLength: 1, maxLength: 20 }
        ),
        async (dbRows) => {
          const db = createMockDb(dbRows);
          const metadata: ExportMetadata = { omittedCount: 0 };

          const output = await collectChunks(
            exportMemories(db, 'test-workspace', 'csv', metadata)
          );

          const lines = output.split('\r\n');
          for (let i = 1; i <= dbRows.length; i++) {
            const line = lines[i];
            // Line must contain quoted field because of comma in text
            expect(line).toMatch(/"[^"]*,comma[^"]*"/);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('property: CSV fields containing double quotes SHALL escape them as two double quotes', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(dbRowArbitrary(), { minLength: 1, maxLength: 20 }).filter(arr => arr.length > 0),
        async (dbRows) => {
          // Transform rows to have text with quotes
          const modifiedRows = dbRows.map(row => ({
            ...row,
            raw_text: `Text with "quotes" inside`,
          }));

          const db = createMockDb(modifiedRows);
          const metadata: ExportMetadata = { omittedCount: 0 };

          const output = await collectChunks(
            exportMemories(db, 'test-workspace', 'csv', metadata)
          );

          const lines = output.split('\r\n');
          for (let i = 1; i <= modifiedRows.length; i++) {
            const line = lines[i];
            // Double quotes must be escaped as ""
            expect(line).toContain('""quotes""');
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('property: CSV fields containing newlines SHALL be quoted', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(
          dbRowArbitrary().map(row => ({
            ...row,
            raw_text: `Line 1\nLine 2\n${row.raw_text}`
          })),
          { minLength: 1, maxLength: 20 }
        ),
        async (dbRows) => {
          const db = createMockDb(dbRows);
          const metadata: ExportMetadata = { omittedCount: 0 };

          const output = await collectChunks(
            exportMemories(db, 'test-workspace', 'csv', metadata)
          );

          const lines = output.split('\r\n');
          for (let i = 1; i <= dbRows.length; i++) {
            const line = lines[i];
            // Line must contain quoted field with embedded newline
            expect(line).toMatch(/"[^"]*\n[^"]*"/);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Export Omitted Count Accuracy
// ---------------------------------------------------------------------------

describe('Property 4: Export Omitted Count Accuracy', () => {
  it('property: omitted count SHALL equal the number of malformed records skipped', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(dbRowArbitrary(), { minLength: 10, maxLength: 100 }),
        fc.integer({ min: 1, max: 10 }), // Number of records to corrupt
        async (dbRows, corruptCount) => {
          // Arrange: corrupt N random records by clearing raw_text
          const corruptedRows = dbRows.map((row, i) => {
            if (i % Math.ceil(dbRows.length / corruptCount) === 0 && i < corruptCount * Math.ceil(dbRows.length / corruptCount)) {
              return { ...row, raw_text: '' }; // Make malformed
            }
            return row;
          });

          const actualCorruptCount = corruptedRows.filter(r => r.raw_text === '').length;
          const db = createMockDb(corruptedRows);
          const metadata: ExportMetadata = { omittedCount: 0 };

          // Act
          const output = await collectChunks(
            exportMemories(db, 'test-workspace', 'json', metadata)
          );

          // Assert: omitted count matches corrupted count
          expect(metadata.omittedCount).toBe(actualCorruptCount);

          // Assert: output contains only valid records
          const parsed = JSON.parse(output);
          expect(parsed.length).toBe(dbRows.length - actualCorruptCount);

          // Assert: no empty text in output
          for (const memory of parsed) {
            expect(memory.text.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ---------------------------------------------------------------------------
// Helper: RFC 4180 CSV Line Parser
// ---------------------------------------------------------------------------

/**
 * Parse a CSV line respecting RFC 4180 quoting rules.
 * 
 * This is a simplified parser for test validation purposes.
 * Handles quoted fields, escaped quotes, and embedded newlines.
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote (two double quotes)
        currentField += '"';
        i += 2;
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
        i++;
      }
    } else if (char === ',' && !inQuotes) {
      // Field separator
      fields.push(currentField);
      currentField = '';
      i++;
    } else {
      // Regular character
      currentField += char;
      i++;
    }
  }

  // Push last field
  if (currentField.length > 0 || line.endsWith(',')) {
    fields.push(currentField);
  }

  return fields;
}
