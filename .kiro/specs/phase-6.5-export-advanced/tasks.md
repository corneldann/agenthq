# Implementation Plan: Phase 6.5 Export Advanced

## Overview

This plan implements the complete memory export/import infrastructure, lifecycle management (decay and graduation), analytics, and automated consolidation. The implementation follows a bottom-up approach: database schema → core services → API routes → tests. Each task builds incrementally with early validation through testing.

## Tasks

- [ ] 1. Database schema migration for memory lifecycle fields
  - Create `migrations/005_memory_lifecycle.sql` adding `stale`, `superseded`, `last_retrieved_at`, and `retrieval_count` columns to `memory_extraction` table
  - Add indexes for decay worker query (`idx_memext_decay`) and analytics quality histogram query (`idx_memext_quality`)
  - Set appropriate DEFAULT values and constraints for all new columns
  - Update `src/db/schema.ts` or equivalent type definitions to reflect new columns
  - _Requirements: 3.1, 3.2, 5.5_

- [ ]* 1.1 Write property test for migration 005 schema correctness
  - **Property 12: Decay threshold correctness** — verify decay query logic
  - **Validates: Requirements 3.2**

- [ ] 2. Extend Memory type and database adapter
  - [ ] 2.1 Update `src/memory/types.ts` to add `stale` and `superseded` boolean fields to `Memory` type
    - Add fields to match extended schema from migration 005
    - Ensure type compatibility with existing code
    - _Requirements: 3.1_
  
  - [ ] 2.2 Update database adapter query methods to handle new fields
    - Modify `list()` and `recall()` to filter out stale memories by default
    - Add `includeStale` parameter support to query methods
    - Update all INSERT and SELECT queries to include new columns
    - _Requirements: 3.3, 3.4_
  
  - [ ]* 2.3 Write property tests for stale filtering
    - **Property 13: Default stale exclusion** — verify stale memories excluded without flag
    - **Property 14: Stale inclusion opt-in** — verify includeStale=true includes stale memories
    - **Validates: Requirements 3.3, 3.4**

- [ ] 3. Implement memory export service
  - [ ] 3.1 Create `src/memory/export.ts` with streaming export generator
    - Implement `exportMemories()` AsyncGenerator function with 500-record batching
    - Support three formats: JSON, Markdown, CSV
    - Track malformed record count and yield formatted chunks
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6_
  
  - [ ] 3.2 Implement format-specific serializers
    - Create `formatJSON()`, `formatMarkdown()`, and `formatCSV()` functions
    - Implement RFC 4180 CSV compliance with proper escaping
    - Include header/footer generation for each format
    - _Requirements: 1.2, 1.3, 1.4_
  
  - [ ]* 3.3 Write property tests for export formats
    - **Property 1: JSON export completeness** — verify all fields present
    - **Property 2: Markdown export format compliance** — verify required sections
    - **Property 3: CSV RFC 4180 compliance** — verify escaping and structure
    - **Property 4: Export omitted count accuracy** — verify malformed record tracking
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.6**

- [ ] 4. Implement memory export route
  - [ ] 4.1 Create `GET /api/memory/export` route in new file or extend existing memory routes
    - Parse and validate `workspaceId` and `format` query parameters
    - Set appropriate `Content-Type` and `Content-Disposition` headers
    - Stream response using export service generator
    - Set `X-Memory-Export-Omitted` header with count
    - _Requirements: 1.1, 1.7, 1.8, 1.9_
  
  - [ ]* 4.2 Write property tests for export route
    - **Property 5: Content-Disposition header format** — verify filename pattern
    - **Property 6: Export parameter validation** — verify 400 on invalid params
    - **Validates: Requirements 1.7, 1.8**
  
  - [ ]* 4.3 Write unit tests for export edge cases
    - Test empty workspace returns 404
    - Test exactly 500 records (batch boundary)
    - Test streaming with network interruption simulation
    - _Requirements: 1.9_

- [ ] 5. Checkpoint — Ensure export tests pass
  - Run all export-related tests and verify streaming works correctly
  - Test export with sample data in all three formats
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement memory import validation pipeline
  - [ ] 6.1 Create `src/memory/import.ts` with validation functions
    - Implement `validateRecord()` with type checking and required field validation
    - Implement `containsTraversal()` regex check for path-traversal sequences
    - Create validation result types and error tracking
    - _Requirements: 2.2, 2.3, 2.4_
  
  - [ ] 6.2 Implement deduplication logic
    - Create `checkDuplicate()` function using embedding cosine similarity (> 0.92 threshold)
    - Integrate with existing `IMemoryClient.recall()` for similarity checks
    - Track skipped count for duplicate records
    - _Requirements: 2.6_
  
  - [ ]* 6.3 Write property tests for import validation
    - **Property 7: Import JSON validation** — verify invalid JSON rejected
    - **Property 8: Import record validation** — verify missing fields counted as invalid
    - **Property 9: Path-traversal rejection** — verify traversal sequences rejected
    - **Property 10: Workspace scope enforcement** — verify scope overwrite
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.5**

- [ ] 7. Implement memory import route
  - [ ] 7.1 Create `POST /api/memory/import` route with multipart form handling
    - Parse multipart/form-data for `file` and `workspaceId` fields
    - Validate file size limit (10 MB) before processing
    - Check `MEMORY_ENABLED` flag and return 503 if disabled
    - _Requirements: 2.1, 2.8, 2.9, 2.10_
  
  - [ ] 7.2 Implement import processing pipeline
    - Parse JSON file and validate top-level array structure
    - Iterate through records, validate each with validation pipeline
    - Overwrite `scope.workspaceId` for all valid records
    - Check duplicates and store valid records
    - Return `{ imported, skipped, invalid }` response
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_
  
  - [ ]* 7.3 Write property tests for import route
    - **Property 11: Import response structure** — verify response format
    - **Validates: Requirements 2.7**
  
  - [ ]* 7.4 Write unit tests for import edge cases
    - Test no file returns 400
    - Test file > 10 MB returns 413
    - Test MEMORY_ENABLED=false returns 503
    - Test exactly 500 records (batch processing)
    - _Requirements: 2.8, 2.9, 2.10_

- [ ] 8. Checkpoint — Ensure import tests pass
  - Run all import-related tests and verify validation pipeline works
  - Test import with malformed data, path-traversal attempts, and duplicates
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Implement memory decay worker
  - [ ] 9.1 Create `src/workers/decay-worker.ts` with nightly scheduling logic
    - Implement `runDecayCycle()` function with parameterized SQL query
    - Query memories with `last_retrieved_at` older than `MEMORY_DECAY_DAYS` threshold
    - Mark matching records as `stale = true` with timestamp update
    - Log completion message with count at INFO level
    - _Requirements: 3.2, 3.6_
  
  - [ ] 9.2 Integrate decay worker with monitor startup
    - Add `startDecayWorker()` function in `src/monitor.ts` or appropriate entry point
    - Schedule worker to run at 02:00 local time via `setInterval` from midnight
    - Implement error handling with logging (no crash on error)
    - _Requirements: 3.2_
  
  - [ ]* 9.3 Write property tests for decay worker
    - **Property 12: Decay threshold correctness** — verify threshold calculation
    - **Property 15: Revive state transition** — verify revive resets stale flag
    - **Validates: Requirements 3.2, 3.6**
  
  - [ ]* 9.4 Write unit tests for decay scheduling
    - Test scheduling logic with fake timers
    - Test decay cycle logging format
    - Test error handling doesn't crash worker
    - _Requirements: 3.6_

- [ ] 10. Implement memory revive functionality
  - [ ] 10.1 Add revive endpoint to memory routes
    - Create `POST /api/memory/revive` accepting `{ id, workspaceId }`
    - Update memory record: set `stale = false`, update `lastRetrievedAt` to now
    - Return success response with updated memory
    - _Requirements: 3.5_
  
  - [ ] 10.2 Update memory browser UI to show "Revive" button
    - Add "Stale" badge rendering in amber for stale memories
    - Show "Revive" button only for stale memories
    - Wire button to revive endpoint
    - _Requirements: 3.4, 3.5_
  
  - [ ]* 10.3 Write unit tests for revive functionality
    - Test revive updates correct fields
    - Test revive on non-stale memory (should succeed with no-op or return current state)
    - Test revive on non-existent memory returns 404
    - _Requirements: 3.5_

- [ ] 11. Implement memory graduation service
  - [ ] 11.1 Create `src/memory/graduation.ts` with graduation logic
    - Implement `graduateMemory()` function with workspace validation
    - Resolve and validate steering file path within `WORKSPACE_ROOT`
    - Check for duplicate text in existing steering file content
    - Append formatted graduation entry to `.kiro/steering/memory-learnings.md`
    - Create file if it doesn't exist
    - _Requirements: 4.2, 4.3, 4.8_
  
  - [ ] 11.2 Implement graduation entry formatter
    - Create `formatGraduationEntry()` function following Markdown template
    - Include ISO date, chain ID (or "unknown"), quality score, and memory text
    - _Requirements: 4.3_
  
  - [ ]* 11.3 Write property tests for graduation service
    - **Property 16: Graduation format compliance** — verify entry structure
    - **Property 17: Graduation response structure** — verify response format
    - **Property 18: Graduation authorization** — verify 404 for wrong workspace
    - **Property 19: Graduation duplicate prevention** — verify 409 for duplicates
    - **Property 20: Graduation path safety** — verify path-traversal protection
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.6, 4.8**

- [ ] 12. Implement memory graduation route
  - [ ] 12.1 Create `POST /api/memory/graduate` route
    - Parse request body `{ id, workspaceId }`
    - Call graduation service with validation
    - Handle errors: 404 for not found, 409 for duplicate, 500 for filesystem errors
    - Return `{ graduated: true, steeringFile: string }` on success
    - _Requirements: 4.1, 4.4, 4.5, 4.6, 4.7_
  
  - [ ]* 12.2 Write unit tests for graduation error cases
    - Test memory not found returns 404
    - Test wrong workspace returns 404
    - Test duplicate text returns 409
    - Test filesystem error returns 500
    - _Requirements: 4.5, 4.6, 4.7_

- [ ] 13. Checkpoint — Ensure decay and graduation tests pass
  - Run all decay and graduation tests
  - Manually test decay worker scheduling with fake timers
  - Test graduation creates steering file correctly
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. Implement memory analytics service
  - [ ] 14.1 Create `src/memory/analytics.ts` with analytics queries
    - Implement `getAnalytics()` function with parameterized SQL queries
    - Query total, stale, tier distribution, embedding status counts
    - Query top 10 retrieved memories by `retrieval_count`
    - Implement quality histogram with 10 buckets (0.0 to 1.0)
    - Calculate extraction success rate from embedding status
    - _Requirements: 5.1, 5.5_
  
  - [ ]* 14.2 Write property tests for analytics
    - **Property 21: Analytics calculation correctness** — verify total count accuracy
    - **Property 23: SQL parameterization** — verify no string interpolation
    - **Validates: Requirements 5.1, 5.5**
  
  - [ ]* 14.3 Write unit tests for analytics edge cases
    - Test empty workspace returns zeros/empty arrays
    - Test histogram bucketing accuracy
    - Test success rate calculation with various embedding status distributions
    - _Requirements: 5.1_

- [ ] 15. Implement memory analytics route
  - [ ] 15.1 Create `GET /api/memory/analytics` route
    - Parse `workspaceId` query parameter
    - Check `MEMORY_ENABLED` flag and return 503 if disabled
    - Call analytics service and return result
    - _Requirements: 5.1, 5.4_
  
  - [ ]* 15.2 Write unit tests for analytics route
    - Test MEMORY_ENABLED=false returns 503
    - Test missing workspaceId returns 400
    - Test analytics response structure matches type
    - _Requirements: 5.4_

- [ ] 16. Implement memory consolidation service
  - [ ] 16.1 Create `src/memory/consolidation.ts` with Auto Dream logic
    - Implement `consolidateWorkspace()` function
    - Call `client.reflect('consolidation', scope)` for LLM synthesis
    - Query all active (non-stale, non-superseded) memories ordered by quality score
    - _Requirements: 5.2_
  
  - [ ] 16.2 Implement duplicate detection and merging
    - Create `findDuplicates()` function with cosine similarity > 0.95 threshold
    - Group duplicate memories and keep highest quality record
    - Delete duplicate records with `deleted_at` timestamp
    - Track merged count
    - _Requirements: 5.2_
  
  - [ ] 16.3 Implement contradiction detection and superseding
    - Parse LLM synthesis to identify contradictory memories
    - Mark contradictory memories as `superseded = true`
    - Track superseded count
    - _Requirements: 5.2_
  
  - [ ] 16.4 Implement target size enforcement
    - Query remaining active memories after merge/supersede
    - If count > 50, mark lowest-quality memories as stale
    - Track flagged stale count
    - Return `{ merged, superseded, flaggedStale }` response
    - _Requirements: 5.3_
  
  - [ ]* 16.5 Write property tests for consolidation
    - **Property 22: Consolidation target enforcement** — verify ≤50 active memories
    - **Validates: Requirements 5.3**
  
  - [ ]* 16.6 Write unit tests for consolidation
    - Test with < 50 memories (no stale marking)
    - Test with exactly 50 memories (no stale marking)
    - Test with > 50 memories (verify lowest quality marked stale)
    - Test duplicate detection with various similarity scores
    - _Requirements: 5.2, 5.3_

- [ ] 17. Implement memory consolidation route
  - [ ] 17.1 Create `POST /api/memory/consolidate` route
    - Parse request body `{ workspaceId }`
    - Check `MEMORY_ENABLED` flag and return 503 if disabled
    - Call consolidation service with workspace scope
    - Return consolidation result counts
    - _Requirements: 5.2, 5.4_
  
  - [ ]* 17.2 Write unit tests for consolidation route
    - Test MEMORY_ENABLED=false returns 503
    - Test response structure matches `ConsolidationResult` type
    - Test consolidation with mock LLM reflect call
    - _Requirements: 5.4_

- [ ] 18. Checkpoint — Ensure analytics and consolidation tests pass
  - Run all analytics and consolidation tests
  - Test consolidation with various workspace sizes
  - Verify all SQL queries use parameterization
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 19. Add environment configuration
  - [ ] 19.1 Update `src/constants.ts` or `src/config.ts` with new constants
    - Add `MEMORY_DECAY_DAYS` constant (default: 90)
    - Document all memory-related environment variables
    - _Requirements: 3.2_
  
  - [ ] 19.2 Update `.env.example` with new variables
    - Add `MEMORY_DECAY_DAYS=90` example
    - Add comments explaining each memory configuration variable
    - _Requirements: 3.2_

- [ ] 20. Integration testing
  - [ ]* 20.1 Write end-to-end export-import test
    - Export 1000 memories in JSON format
    - Import exported file to new workspace
    - Verify imported count matches original
    - Verify workspace scope correctly overwritten
    - _Requirements: 1.1, 2.1, 2.5_
  
  - [ ]* 20.2 Write end-to-end decay test
    - Create 100 memories with various `lastRetrievedAt` values
    - Run decay cycle
    - Verify stale count matches threshold
    - Query with and without `includeStale` flag
    - _Requirements: 3.2, 3.3, 3.4_
  
  - [ ]* 20.3 Write end-to-end graduation test
    - Graduate high-quality memory
    - Verify steering file content matches format
    - Attempt duplicate graduation
    - Verify 409 response
    - _Requirements: 4.2, 4.3, 4.6_
  
  - [ ]* 20.4 Write end-to-end consolidation test
    - Create 75 memories with some duplicates
    - Run consolidation
    - Verify ≤50 active memories remain
    - Verify duplicates merged
    - Verify lowest quality marked stale
    - _Requirements: 5.2, 5.3_

- [ ] 21. Documentation and logging
  - [ ] 21.1 Add logging for all major operations
    - Export: log format, workspace, record count
    - Import: log imported/skipped/invalid counts
    - Decay: log cycle completion with affected count
    - Graduation: log successful graduations with memory ID
    - Consolidation: log merged/superseded/flagged counts
    - Use appropriate log levels (INFO, WARN, ERROR)
    - _Requirements: 3.6_
  
  - [ ] 21.2 Add security logging
    - Log path-traversal attempts at ERROR level
    - Log import file size rejections at WARN level
    - Log MEMORY_ENABLED=false rejections at INFO level
    - Sanitize all user input in logs
    - _Requirements: 2.4, 2.8_

- [ ] 22. Update API documentation
  - [ ] 22.1 Document new endpoints
    - Document `GET /api/memory/export` with parameters and response format
    - Document `POST /api/memory/import` with request/response structure
    - Document `POST /api/memory/revive` endpoint
    - Document `POST /api/memory/graduate` endpoint
    - Document `GET /api/memory/analytics` with response structure
    - Document `POST /api/memory/consolidate` with response structure
    - Include example requests and responses for each endpoint

- [ ] 23. Final integration verification
  - Run full test suite with all property-based and unit tests
  - Test all endpoints manually or via integration tests
  - Verify migration 005 applies cleanly on test database
  - Verify decay worker schedules correctly
  - Test export/import with large datasets (>1000 memories)
  - Test consolidation reduces corpus to target size
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for faster MVP
- Property-based tests use `fast-check` library (already in devDependencies)
- All tests reference their design property number for traceability
- Checkpoints ensure incremental validation after major feature groups
- SQL parameterization is enforced throughout to prevent injection attacks
- Path-traversal protection is critical for import and graduation features
- Streaming export prevents memory exhaustion for large workspaces
- Decay worker runs asynchronously and doesn't block main thread

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["1.1", "2.1", "19.1"] },
    { "id": 2, "tasks": ["2.2", "19.2"] },
    { "id": 3, "tasks": ["2.3", "3.1"] },
    { "id": 4, "tasks": ["3.2"] },
    { "id": 5, "tasks": ["3.3", "4.1"] },
    { "id": 6, "tasks": ["4.2", "4.3"] },
    { "id": 7, "tasks": ["6.1"] },
    { "id": 8, "tasks": ["6.2"] },
    { "id": 9, "tasks": ["6.3", "7.1"] },
    { "id": 10, "tasks": ["7.2"] },
    { "id": 11, "tasks": ["7.3", "7.4"] },
    { "id": 12, "tasks": ["9.1"] },
    { "id": 13, "tasks": ["9.2"] },
    { "id": 14, "tasks": ["9.3", "9.4", "10.1"] },
    { "id": 15, "tasks": ["10.2"] },
    { "id": 16, "tasks": ["10.3", "11.1"] },
    { "id": 17, "tasks": ["11.2"] },
    { "id": 18, "tasks": ["11.3", "12.1"] },
    { "id": 19, "tasks": ["12.2"] },
    { "id": 20, "tasks": ["14.1"] },
    { "id": 21, "tasks": ["14.2", "14.3", "15.1"] },
    { "id": 22, "tasks": ["15.2", "16.1"] },
    { "id": 23, "tasks": ["16.2"] },
    { "id": 24, "tasks": ["16.3"] },
    { "id": 25, "tasks": ["16.4"] },
    { "id": 26, "tasks": ["16.5", "16.6", "17.1"] },
    { "id": 27, "tasks": ["17.2"] },
    { "id": 28, "tasks": ["20.1", "20.2", "20.3", "20.4"] },
    { "id": 29, "tasks": ["21.1", "21.2"] },
    { "id": 30, "tasks": ["22.1"] }
  ]
}
```
