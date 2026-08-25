# Requirements Document

## Introduction

Phase 6.5 completes the memory feature set with export/import, memory decay, graduation of
high-value memories into steering files, memory analytics, and Auto Dream consolidation.
These features make the memory store maintainable at scale and enable knowledge transfer
between workspaces and team members.

**Prerequisite:** Phase 6.4 complete. Memory browser operational.

---

## Glossary

| Term | Definition |
|------|-----------|
| **Memory decay** | Marking memories as `stale` when not retrieved within `MEMORY_DECAY_DAYS`. Stale memories are excluded from default recall but not deleted. |
| **Memory graduation** | Promoting a high-confidence memory into the workspace's `memory-learnings.md` steering file for permanent procedural retention. |
| **Auto Dream** | The consolidation cycle from the `memory-consolidation` skill: merge duplicates, supersede contradictions, flag stale facts, target ≤ 50 active entities. |
| **Export** | Streaming serialisation of workspace memories to JSON, Markdown, or CSV. |
| **Import** | Bulk-insert of a JSON export file with validation, deduplication, and path-traversal protection. |

---

## Requirements

### Requirement 1: Memory Export

**User Story:** As a developer, I want to export all memories for a workspace so that I can
back them up, share them with teammates, or load them into a new workspace.

#### Acceptance Criteria

1. `GET /api/memory/export?workspaceId=<id>&format=json|markdown|csv` streams the response.
2. JSON format: a JSON array of `Memory` objects, one element per memory, with all fields.
3. Markdown format: one `## Memory` section per memory, showing text, scope, quality score,
   and ISO timestamp.
4. CSV format: RFC 4180 compliant with headers `id,text,workspaceId,chainId,qualityScore,
   createdAt,tier,embeddingStatus`.
5. Memories are streamed in batches of 500 to avoid loading the full corpus into memory.
6. Malformed memory records (missing required fields) are omitted from the export; a count
   of omitted records is included in the response header
   `X-Memory-Export-Omitted: <count>`.
7. The response `Content-Disposition` header is set to
   `attachment; filename="memories-{workspaceId}-{date}.{ext}"`.
8. WHERE the `format` query parameter is not one of `json`, `markdown`, or `csv`, or the
   `workspaceId` parameter is absent or malformed, THEN the system SHALL return 400 with a
   descriptive error message identifying which parameter is invalid.
9. WHERE no memories exist for the requested workspace, THEN the system SHALL return 404
   rather than an empty export file.

### Requirement 2: Memory Import

**User Story:** As a developer, I want to import a memory export file into a workspace so
that I can seed a new workspace with prior knowledge or restore from a backup.

#### Acceptance Criteria

1. `POST /api/memory/import` accepts `multipart/form-data` with a `file` field containing
   a JSON export file and a `workspaceId` field for the target workspace.
2. WHERE a file has been successfully uploaded, THEN the import SHALL validate the file is
   parseable JSON and that the top-level value is an array before proceeding.
3. Each record is validated for required fields (`text`, `scope.workspaceId`); invalid
   records are skipped with a count tracked.
4. Path-traversal sequences (`..`, `//`, `\\`) in any string field cause the entire record
   to be rejected and the rejection logged.
5. WHERE a file has been successfully uploaded, THEN the system SHALL overwrite the
   `scope.workspaceId` in each imported record with the `workspaceId` from the request to
   prevent cross-workspace leakage.
6. WHERE a file has been successfully uploaded, THEN before storing each record the system
   SHALL perform a deduplication check; records with cosine similarity > 0.92 to an
   existing memory SHALL be skipped.
7. Import returns `{ imported: number, skipped: number, invalid: number }` with status 200.
8. IF the uploaded file exceeds 10 MB, THEN the system SHALL reject the import with 413.
9. IF `MEMORY_ENABLED=false`, THEN the system SHALL reject the import with 503 without
   processing the file.
10. IF no file is present in the request, THEN the system SHALL return 400 and SHALL NOT
    proceed with any import logic.

### Requirement 3: Memory Decay

**User Story:** As a developer, I want memories that haven't been used in a long time to be
automatically deprioritised so that stale knowledge doesn't pollute recall results.

#### Acceptance Criteria

1. A `stale` boolean field is added to the `Memory` type and the `memory_extraction` table
   (via migration 005 or an ALTER TABLE in migration 004's companion script).
2. A nightly worker (runs at 02:00 local time via `setInterval` from midnight) queries
   memories whose `lastRetrievedAt` is older than `MEMORY_DECAY_DAYS` (default 90) and
   marks them as `stale = true` in the local DB.
3. `GET /api/memory/list` and `GET /api/memory/search` exclude stale memories by default.
   An opt-in query param `includeStale=true` includes them.
4. The memory browser renders stale memories with a "Stale" badge in amber.
5. WHERE a memory card is stale, THEN a "Revive" button SHALL be displayed that resets
   `stale = false` and updates `lastRetrievedAt` to now. WHERE a memory is not stale, THEN
   the "Revive" button SHALL be hidden or disabled.
6. WHEN the nightly decay cycle completes, the decay worker SHALL log
   `Memory decay: N memories marked stale for workspace {id}` at INFO level, WHERE N
   represents the net change in stale memories after accounting for any revivals or resets
   that occurred during the same cycle.

### Requirement 4: Memory Graduation

**User Story:** As a developer, I want to promote a high-value memory into a permanent
steering file entry so that it becomes procedural knowledge that applies to every future
session without needing a recall step.

#### Acceptance Criteria

1. `POST /api/memory/graduate` accepts `{ id: string, workspaceId: string }`.
2. It retrieves the memory by ID, validates it belongs to the specified workspace, then
   appends a new `## Learned` section to `.kiro/steering/memory-learnings.md` in the
   workspace root. If the file does not exist it is created.
3. The appended section format is:
   ```markdown
   ## Learned — {ISO date}

   **Source chain:** {chainId or "unknown"}
   **Quality score:** {qualityScore}

   {memory text}
   ```
4. Returns `{ graduated: true, steeringFile: string }` with the absolute path to the
   steering file on success.
5. WHERE the memory ID does not exist or belongs to a different workspace, THEN the system
   SHALL return 404.
6. WHEN a graduation request is received, the system SHALL first check whether the identical
   memory text is already present in the steering file; IF it is, THEN the system SHALL
   return 409 regardless of whether the memory ID exists.
7. IF graduation fails due to a file system error or other technical reason (not a 404 or
   409 condition), THEN the system SHALL return 500.
8. Path-traversal protection: the workspace root path is resolved and verified to be within
   `WORKSPACE_ROOT` before any file write.

### Requirement 5: Memory Analytics and Consolidation

**User Story:** As a developer, I want analytics on my memory store and a consolidation
command so that I can understand how well the memory system is working and keep it clean.

#### Acceptance Criteria

1. `GET /api/memory/analytics?workspaceId=<id>` returns:
   `{ total, stale, hotCount, coldCount, pendingEmbedding, topRetrieved: Memory[10],
   qualityHistogram: { buckets: [{min,max,count}] }, extractionSuccessRate }`.
2. `POST /api/memory/consolidate` triggers the Auto Dream pattern for the given
   `workspaceId`: calls `client.reflect("consolidation", scope)` to get a synthesis,
   then identifies and deletes duplicate memories (cosine > 0.95), marks contradictions
   as superseded, and returns `{ merged, superseded, flaggedStale }` counts.
3. The consolidation run targets ≤ 50 active (non-stale, non-superseded) memories per
   workspace. If the active count exceeds 50 after merging, the lowest-quality memories
   are marked stale until the target is reached.
4. IF `MEMORY_ENABLED=false`, THEN all memory operations — including `GET /api/memory/analytics`,
   `POST /api/memory/consolidate`, and all other memory endpoints — SHALL return 503
   immediately without executing any analytics logic or database queries.
5. All analytics queries use parameterised SQL against the `memory_extraction` table — no
   string interpolation of `workspaceId` or any other user-supplied value.
