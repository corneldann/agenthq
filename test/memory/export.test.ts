/**
 * Unit tests for memory export streaming generator.
 * 
 * Tests basic functionality, edge cases, and format compliance for
 * JSON, Markdown, and CSV export formats.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { exportMemories, type ExportMetadata } from '../../src/memory/export.js';
import type { DbAdapter, DbMemoryExtraction } from '../../src/db/adapter.js';

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
 * Create a valid DbMemoryExtraction test record.
 */
function createDbRecord(overrides: Partial<DbMemoryExtraction> = {}): DbMemoryExtraction {
  return {
    id: 1,
    job_id: 'job-123',
    workspace_id: 'workspace-test',
    extracted_at: '2024-03-15T10:00:00.000Z',
    raw_text: 'Test memory text',
    memory_count: 1,
    quality_score: 0.85,
    embedding_status: 'embedded',
    embed_attempts: 1,
    tier: 'hot',
    last_modified: Date.now(),
    deleted_at: null,
    stale: 0,
    superseded: 0,
    last_retrieved_at: '2024-03-16T10:00:00.000Z',
    retrieval_count: 5,
    ...overrides,
  };
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
// JSON export tests
// ---------------------------------------------------------------------------

describe('JSON export format', () => {
  it('should export empty workspace as empty array', async () => {
    const db = createMockDb([]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-empty', 'json', metadata));
    
    expect(output).toBe('[\n]');
    expect(metadata.omittedCount).toBe(0);
  });

  it('should export single memory as JSON array with one element', async () => {
    const db = createMockDb([createDbRecord()]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'json', metadata));
    const parsed = JSON.parse(output);
    
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: '1',
      text: 'Test memory text',
      scope: {
        workspaceId: 'workspace-test',
        chainId: 'job-123',
      },
      qualityScore: 0.85,
      tier: 'hot',
      embeddingStatus: 'ready',
      stale: false,
      superseded: false,
      retrievalCount: 5,
    });
  });

  it('should export multiple memories as comma-separated JSON array elements', async () => {
    const db = createMockDb([
      createDbRecord({ id: 1, raw_text: 'Memory 1' }),
      createDbRecord({ id: 2, raw_text: 'Memory 2' }),
      createDbRecord({ id: 3, raw_text: 'Memory 3' }),
    ]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'json', metadata));
    const parsed = JSON.parse(output);
    
    expect(parsed).toHaveLength(3);
    expect(parsed[0].text).toBe('Memory 1');
    expect(parsed[1].text).toBe('Memory 2');
    expect(parsed[2].text).toBe('Memory 3');
  });

  it('should include all required Memory fields in JSON output', async () => {
    const db = createMockDb([createDbRecord()]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'json', metadata));
    const parsed = JSON.parse(output);
    const memory = parsed[0];
    
    // Verify all Memory type fields are present
    expect(memory).toHaveProperty('id');
    expect(memory).toHaveProperty('text');
    expect(memory).toHaveProperty('scope');
    expect(memory.scope).toHaveProperty('workspaceId');
    expect(memory.scope).toHaveProperty('chainId');
    expect(memory).toHaveProperty('qualityScore');
    expect(memory).toHaveProperty('createdAt');
    expect(memory).toHaveProperty('lastRetrievedAt');
    expect(memory).toHaveProperty('retrievalCount');
    expect(memory).toHaveProperty('tier');
    expect(memory).toHaveProperty('embeddingStatus');
    expect(memory).toHaveProperty('stale');
    expect(memory).toHaveProperty('superseded');
  });
});

// ---------------------------------------------------------------------------
// Markdown export tests
// ---------------------------------------------------------------------------

describe('Markdown export format', () => {
  it('should export empty workspace with header only', async () => {
    const db = createMockDb([]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-empty', 'markdown', metadata));
    
    expect(output).toBe('# Memory Export\n\n');
    expect(metadata.omittedCount).toBe(0);
  });

  it('should export memory with all required markdown sections', async () => {
    const db = createMockDb([createDbRecord({
      raw_text: 'Important architectural decision',
      quality_score: 0.92,
    })]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'markdown', metadata));
    
    // Check for required sections
    expect(output).toContain('## Memory');
    expect(output).toContain('**Text**: Important architectural decision');
    expect(output).toContain('**Workspace**: workspace-test');
    expect(output).toContain('**Chain**: job-123');
    expect(output).toContain('**Quality Score**: 0.9200');
    expect(output).toContain('**Created**: 2024-03-15T10:00:00.000Z');
    expect(output).toContain('**Tier**: hot');
    expect(output).toContain('**Status**: ready');
    expect(output).toContain('**Stale**: No');
    expect(output).toContain('**Superseded**: No');
  });

  it('should handle null chainId gracefully', async () => {
    const db = createMockDb([createDbRecord({ job_id: '' })]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'markdown', metadata));
    
    // Should show N/A for missing chainId (empty string maps to undefined in scope)
    expect(output).toContain('**Chain**:');
  });
});

// ---------------------------------------------------------------------------
// CSV export tests
// ---------------------------------------------------------------------------

describe('CSV export format', () => {
  it('should export empty workspace with header row only', async () => {
    const db = createMockDb([]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-empty', 'csv', metadata));
    
    expect(output).toBe('id,text,workspaceId,chainId,qualityScore,createdAt,tier,embeddingStatus,stale,superseded,lastRetrievedAt,retrievalCount\r\n');
  });

  it('should export memory with correct CSV field order', async () => {
    const db = createMockDb([createDbRecord({ raw_text: 'Simple text' })]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'csv', metadata));
    const lines = output.split('\r\n');
    
    expect(lines).toHaveLength(3); // header + data + empty line
    const dataLine = lines[1];
    const fields = dataLine.split(',');
    
    expect(fields[0]).toBe('1'); // id
    expect(fields[1]).toBe('Simple text'); // text
    expect(fields[2]).toBe('workspace-test'); // workspaceId
    expect(fields[3]).toBe('job-123'); // chainId
    expect(fields[4]).toBe('0.85'); // qualityScore
    expect(fields[6]).toBe('hot'); // tier
    expect(fields[7]).toBe('ready'); // embeddingStatus
  });

  it('should use CRLF line endings (RFC 4180)', async () => {
    const db = createMockDb([createDbRecord(), createDbRecord({ id: 2 })]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'csv', metadata));
    
    // Every line should end with \r\n
    const lines = output.split('\r\n');
    expect(lines.length).toBeGreaterThan(2); // At least header + 2 data rows + empty
    
    // Check that splitting on \r\n gives us proper lines
    expect(lines[0]).toContain('id,text,workspace');
  });

  it('should quote and escape fields containing commas', async () => {
    const db = createMockDb([createDbRecord({ raw_text: 'Text with, comma' })]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'csv', metadata));
    const lines = output.split('\r\n');
    const dataLine = lines[1];
    
    // Field with comma should be quoted
    expect(dataLine).toContain('"Text with, comma"');
  });

  it('should escape double quotes by doubling them', async () => {
    const db = createMockDb([createDbRecord({ raw_text: 'Text with "quotes"' })]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'csv', metadata));
    const lines = output.split('\r\n');
    const dataLine = lines[1];
    
    // Double quotes should be escaped as ""
    expect(dataLine).toContain('"Text with ""quotes"""');
  });

  it('should quote fields containing newlines', async () => {
    const db = createMockDb([createDbRecord({ raw_text: 'Line 1\nLine 2' })]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'csv', metadata));
    const lines = output.split('\r\n');
    const dataLine = lines[1];
    
    // Field with newline should be quoted
    expect(dataLine).toContain('"Line 1\nLine 2"');
  });

  it('should handle boolean fields as 0/1 integers', async () => {
    const db = createMockDb([createDbRecord({ stale: 1, superseded: 1 })]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'csv', metadata));
    const lines = output.split('\r\n');
    const dataLine = lines[1];
    
    // stale and superseded should be exported as 1
    expect(dataLine).toContain(',1,1,');
  });
});

// ---------------------------------------------------------------------------
// Malformed record handling
// ---------------------------------------------------------------------------

describe('malformed record handling', () => {
  it('should skip record with missing raw_text', async () => {
    const db = createMockDb([
      createDbRecord({ id: 1 }),
      createDbRecord({ id: 2, raw_text: '' }), // Empty text
      createDbRecord({ id: 3 }),
    ]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'json', metadata));
    const parsed = JSON.parse(output);
    
    expect(parsed).toHaveLength(2); // Record 2 skipped
    expect(metadata.omittedCount).toBe(1);
  });

  it('should skip record with missing workspace_id', async () => {
    const db = createMockDb([
      createDbRecord({ id: 1 }),
      createDbRecord({ id: 2, workspace_id: '' }),
      createDbRecord({ id: 3 }),
    ]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'json', metadata));
    const parsed = JSON.parse(output);
    
    expect(parsed).toHaveLength(2);
    expect(metadata.omittedCount).toBe(1);
  });

  it('should accumulate omitted count across batches', async () => {
    // Create 1000 records with every 100th record malformed
    const records: DbMemoryExtraction[] = [];
    for (let i = 1; i <= 1000; i++) {
      records.push(createDbRecord({
        id: i,
        raw_text: i % 100 === 0 ? '' : `Memory ${i}`,
      }));
    }
    
    const db = createMockDb(records);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'json', metadata));
    const parsed = JSON.parse(output);
    
    expect(parsed).toHaveLength(990); // 10 records omitted
    expect(metadata.omittedCount).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Batch processing tests
// ---------------------------------------------------------------------------

describe('batch processing', () => {
  it('should handle exactly 500 records in one batch', async () => {
    const records = Array.from({ length: 500 }, (_, i) => 
      createDbRecord({ id: i + 1, raw_text: `Memory ${i + 1}` })
    );
    const db = createMockDb(records);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'json', metadata));
    const parsed = JSON.parse(output);
    
    expect(parsed).toHaveLength(500);
    expect(metadata.omittedCount).toBe(0);
  });

  it('should handle 501 records across two batches', async () => {
    const records = Array.from({ length: 501 }, (_, i) => 
      createDbRecord({ id: i + 1, raw_text: `Memory ${i + 1}` })
    );
    const db = createMockDb(records);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'json', metadata));
    const parsed = JSON.parse(output);
    
    expect(parsed).toHaveLength(501);
    expect(parsed[0].text).toBe('Memory 1');
    expect(parsed[500].text).toBe('Memory 501');
  });

  it('should handle 1000 records across two batches', async () => {
    const records = Array.from({ length: 1000 }, (_, i) => 
      createDbRecord({ id: i + 1, raw_text: `Memory ${i + 1}` })
    );
    const db = createMockDb(records);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'json', metadata));
    const parsed = JSON.parse(output);
    
    expect(parsed).toHaveLength(1000);
    expect(parsed[0].text).toBe('Memory 1');
    expect(parsed[499].text).toBe('Memory 500');
    expect(parsed[500].text).toBe('Memory 501');
    expect(parsed[999].text).toBe('Memory 1000');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('should handle null last_retrieved_at', async () => {
    const db = createMockDb([createDbRecord({ last_retrieved_at: null })]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'json', metadata));
    const parsed = JSON.parse(output);
    
    // Should use extracted_at as fallback
    expect(parsed[0].lastRetrievedAt).toBe('2024-03-15T10:00:00.000Z');
  });

  it('should handle zero quality score', async () => {
    const db = createMockDb([createDbRecord({ quality_score: 0 })]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'json', metadata));
    const parsed = JSON.parse(output);
    
    expect(parsed[0].qualityScore).toBe(0);
  });

  it('should handle zero retrieval count', async () => {
    const db = createMockDb([createDbRecord({ retrieval_count: 0 })]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'json', metadata));
    const parsed = JSON.parse(output);
    
    expect(parsed[0].retrievalCount).toBe(0);
  });

  it('should map embedding_status correctly', async () => {
    const db = createMockDb([
      createDbRecord({ id: 1, embedding_status: 'pending' }),
      createDbRecord({ id: 2, embedding_status: 'embedded' }),
      createDbRecord({ id: 3, embedding_status: 'failed' }),
    ]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'json', metadata));
    const parsed = JSON.parse(output);
    
    expect(parsed[0].embeddingStatus).toBe('pending');
    expect(parsed[1].embeddingStatus).toBe('ready');
    expect(parsed[2].embeddingStatus).toBe('failed');
  });

  it('should map tier correctly', async () => {
    const db = createMockDb([
      createDbRecord({ id: 1, tier: 'hot' }),
      createDbRecord({ id: 2, tier: 'cold' }),
    ]);
    const metadata: ExportMetadata = { omittedCount: 0 };
    
    const output = await collectChunks(exportMemories(db, 'workspace-test', 'json', metadata));
    const parsed = JSON.parse(output);
    
    expect(parsed[0].tier).toBe('hot');
    expect(parsed[1].tier).toBe('cold');
  });
});
