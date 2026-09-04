/**
 * Memory export streaming generator for Phase 6.5.
 * 
 * Implements streaming export of workspace memories to JSON, Markdown, or CSV
 * formats with 500-record batching to avoid loading full corpus into memory.
 * Malformed records (missing required fields) are skipped and tracked.
 * 
 * Export formats:
 * - JSON: Array of Memory objects with all fields
 * - Markdown: One `## Memory` section per memory with formatted fields
 * - CSV: RFC 4180 compliant with proper escaping and CRLF line endings
 */

import type { DbAdapter, DbMemoryExtraction } from '../db/adapter.js';
import type { Memory } from './types.js';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export type ExportFormat = 'json' | 'markdown' | 'csv';

export type ExportMetadata = {
  omittedCount: number;  // Count of malformed records skipped during export
};

// ---------------------------------------------------------------------------
// Streaming export generator
// ---------------------------------------------------------------------------

/**
 * Stream workspace memories in the specified format using 500-record batches.
 * 
 * Yields format-specific chunks (headers, records, footers) as strings.
 * Malformed records (missing required fields) are silently skipped; the
 * omitted count is returned via metadata parameter mutation.
 * 
 * @param db Database adapter
 * @param workspaceId Target workspace ID
 * @param format Output format: json, markdown, or csv
 * @param metadata Mutable object to track omitted records count
 */
export async function* exportMemories(
  db: DbAdapter,
  workspaceId: string,
  format: ExportFormat,
  metadata: ExportMetadata,
): AsyncGenerator<string> {
  const batchSize = 500;
  let offset = 0;
  let isFirstElement = true; // Track if we've yielded any valid elements yet

  // Yield format-specific header
  yield formatHeader(format);

  while (true) {
    const { rows } = await db.query<DbMemoryExtraction>(
      `SELECT * FROM memory_extraction 
       WHERE workspace_id = ? AND deleted_at IS NULL 
       ORDER BY extracted_at DESC LIMIT ? OFFSET ?`,
      [workspaceId, batchSize, offset],
    );

    if (rows.length === 0) break;

    for (const row of rows) {
      // Validate record has required fields
      if (!isValidRecord(row)) {
        metadata.omittedCount++;
        continue;
      }

      // Convert DB row to Memory type
      const memory = dbRowToMemory(row);

      // Yield record separator (for JSON array, skip before first element)
      if (format === 'json' && !isFirstElement) {
        yield ',\n';
      } else if (format === 'json' && isFirstElement) {
        yield '\n';
      }

      // Yield formatted record
      yield formatRecord(memory, format);

      isFirstElement = false;
    }

    offset += batchSize;
  }

  // Yield format-specific footer
  yield formatFooter(format);
}

// ---------------------------------------------------------------------------
// Format-specific header/footer
// ---------------------------------------------------------------------------

function formatHeader(format: ExportFormat): string {
  switch (format) {
    case 'json':
      return '[';
    case 'markdown':
      return '# Memory Export\n\n';
    case 'csv':
      return 'id,text,workspaceId,chainId,qualityScore,createdAt,tier,embeddingStatus,stale,superseded,lastRetrievedAt,retrievalCount\r\n';
  }
}

function formatFooter(format: ExportFormat): string {
  switch (format) {
    case 'json':
      return '\n]';
    case 'markdown':
    case 'csv':
      return '';
  }
}

// ---------------------------------------------------------------------------
// Record formatting
// ---------------------------------------------------------------------------

function formatRecord(memory: Memory, format: ExportFormat): string {
  switch (format) {
    case 'json':
      return formatJSON(memory);
    case 'markdown':
      return formatMarkdown(memory);
    case 'csv':
      return formatCSV(memory);
  }
}

function formatJSON(memory: Memory): string {
  return JSON.stringify(memory, null, 2);
}

function formatMarkdown(memory: Memory): string {
  return `## Memory

**ID**: ${memory.id}
**Text**: ${memory.text}
**Workspace**: ${memory.scope.workspaceId}
**Chain**: ${memory.scope.chainId ?? 'N/A'}
**Quality Score**: ${memory.qualityScore.toFixed(4)}
**Created**: ${memory.createdAt}
**Last Retrieved**: ${memory.lastRetrievedAt ?? 'Never'}
**Retrieval Count**: ${memory.retrievalCount}
**Tier**: ${memory.tier}
**Status**: ${memory.embeddingStatus}
**Stale**: ${memory.stale ? 'Yes' : 'No'}
**Superseded**: ${memory.superseded ? 'Yes' : 'No'}

---

`;
}

/**
 * Format memory as RFC 4180 compliant CSV record with CRLF line ending.
 * 
 * RFC 4180 rules:
 * - Fields containing comma, quote, or newline MUST be enclosed in double quotes
 * - Double quotes inside quoted fields MUST be escaped as two double quotes ("")
 * - Line endings MUST be CRLF (\r\n)
 */
function formatCSV(memory: Memory): string {
  const fields = [
    memory.id,
    memory.text,
    memory.scope.workspaceId,
    memory.scope.chainId ?? '',
    memory.qualityScore.toString(),
    memory.createdAt,
    memory.tier,
    memory.embeddingStatus,
    memory.stale ? '1' : '0',
    memory.superseded ? '1' : '0',
    memory.lastRetrievedAt ?? '',
    memory.retrievalCount.toString(),
  ];

  // Escape and quote fields according to RFC 4180
  const escapedFields = fields.map(field => {
    const str = String(field);
    // Field needs quoting if it contains comma, quote, newline, or carriage return
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      // Escape double quotes by doubling them
      const escaped = str.replace(/"/g, '""');
      return `"${escaped}"`;
    }
    return str;
  });

  return escapedFields.join(',') + '\r\n';
}

// ---------------------------------------------------------------------------
// Validation and conversion
// ---------------------------------------------------------------------------

/**
 * Check if a DB row has all required fields for export.
 * 
 * Required fields: id, raw_text, workspace_id, quality_score, extracted_at,
 * tier, embedding_status, stale, superseded, retrieval_count.
 * 
 * Optional fields that can be null: last_retrieved_at, deleted_at (but we
 * already filter deleted_at IS NULL in the query).
 */
function isValidRecord(row: DbMemoryExtraction): boolean {
  return (
    typeof row.id === 'number' &&
    typeof row.raw_text === 'string' &&
    row.raw_text.length > 0 &&
    typeof row.workspace_id === 'string' &&
    row.workspace_id.length > 0 &&
    typeof row.quality_score === 'number' &&
    typeof row.extracted_at === 'string' &&
    typeof row.tier === 'string' &&
    typeof row.embedding_status === 'string' &&
    typeof row.stale === 'number' &&
    typeof row.superseded === 'number' &&
    typeof row.retrieval_count === 'number'
  );
}

/**
 * Convert DbMemoryExtraction row to Memory type.
 * 
 * Maps database schema to domain model:
 * - id: number → string (using toString for consistency)
 * - raw_text → text
 * - stale: 0/1 integer → boolean
 * - superseded: 0/1 integer → boolean
 * - last_retrieved_at: null or ISO string → string (use extracted_at as fallback)
 */
function dbRowToMemory(row: DbMemoryExtraction): Memory {
  return {
    id: row.id.toString(),
    text: row.raw_text,
    scope: {
      workspaceId: row.workspace_id,
      chainId: row.job_id,  // Use job_id as chainId approximation
    },
    qualityScore: row.quality_score,
    createdAt: row.extracted_at,
    lastRetrievedAt: row.last_retrieved_at ?? row.extracted_at,
    retrievalCount: row.retrieval_count,
    tier: row.tier === 'hot' ? 'hot' : (row.tier === 'cold' ? 'cold' : 'warm'),
    embeddingStatus: 
      row.embedding_status === 'pending' ? 'pending' :
      row.embedding_status === 'embedded' ? 'ready' :
      'failed',
    stale: row.stale === 1,
    superseded: row.superseded === 1,
  };
}
