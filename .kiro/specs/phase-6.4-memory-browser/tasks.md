# Implementation Plan: Phase 6.4 — Memory Browser

## Skill Activation — REQUIRED before every task

**Call `disclose_context` for these skills before writing any code or tests:**

| Always | `accelint-ts-best-practices`, `accelint-ts-testing` |
|--------|------------------------------------------------------|
| + DB / backend / routes | `error-handling-patterns` |
| + dashboard / UI | `agenthq-dashboard` |
| + performance / query timing | `accelint-ts-performance` |
| + security / validation / SQL | `best-practices` |
| + JSDoc / comments | `accelint-ts-documentation` |
| + refactoring / coupling | `improve-codebase-architecture` |

These skills do NOT activate automatically during spec task execution.
`disclose_context` must be called explicitly at the start of each task.

---

## Overview

This implementation plan converts the Phase 6.4 design into actionable coding tasks. The memory browser adds a fifth dashboard page with REST routes, timeline/graph views, and real-time updates. Each task builds incrementally, with property-based tests ensuring correctness properties hold.

## Tasks

- [x] 1. Create REST route module with shared guards
  - [x] 1.1 Implement route module structure and registration function
    - Create `src/routes/memory-browser.ts` with `register(router, client, breaker)` function
    - Implement `resolveLimit(raw, defaultVal, max): number` pure helper for query param validation
    - Add JSDoc annotations for all exported functions
    - _Requirements: 1.1, 1.9_
  
  - [x] 1.2 Write property test for resolveLimit clamping
    - **Property 1: Limit resolution clamps to valid range**
    - **Validates: Requirements 1.1**
    - Test with fc.option(fc.oneof(fc.integer(), fc.string()), { nil: null })
    - Verify result is always in [1, max] and equals defaultVal when input invalid
    - _Requirements: 1.1_
  
  - [x] 1.3 Implement shared guard functions
    - Create `checkMemoryEnabled()` guard returning 503 when MEMORY_ENABLED=false
    - Create `checkCircuitBreaker()` guard returning 502 with metrics when Open
    - Create `validateWorkspaceId()` guard returning 400 for missing/empty workspaceId
    - Implement error mapping helper for MemoryTimeoutError → 504, MemoryServiceError → 502
    - _Requirements: 1.7, 1.8, 1.9_
  
  - [x] 1.4 Write property test for MEMORY_ENABLED guard universality
    - **Property 3: MEMORY_ENABLED=false guard applies to all protected routes**
    - **Validates: Requirements 1.7**
    - Test all 6 protected routes return 503 when memory disabled
    - _Requirements: 1.7_
  
  - [x] 1.5 Write property test for workspaceId validation consistency
    - **Property 4: workspaceId validation is consistent across all routes**
    - **Validates: Requirements 1.9**
    - Test all routes return 400 for empty/null/whitespace-only workspaceId
    - _Requirements: 1.9_

- [x] 2. Implement memory search and list routes
  - [x] 2.1 Implement GET /api/memory/search route handler
    - Parse query, workspaceId, limit params with resolveLimit (default 20, max 100)
    - Apply shared guards (feature flag, circuit breaker, workspaceId)
    - Call client.recall with parsed params
    - Map errors to HTTP status codes per error mapping table
    - Return Memory[] array on success
    - _Requirements: 1.1, 1.7, 1.8, 1.9_
  
  - [x] 2.2 Implement GET /api/memory/list route handler
    - Parse workspaceId, cursor, pageSize params (default pageSize 50, max 100)
    - Apply shared guards
    - Call client.list with parsed params
    - Sort memories by createdAt DESC before returning
    - Return { memories: Memory[], nextCursor: string | null, total: number }
    - _Requirements: 1.2, 1.7, 1.8, 1.9_
  
  - [x] 2.3 Write property test for memory list sort order
    - **Property 2: Memory list is sorted descending by createdAt**
    - **Validates: Requirements 1.2**
    - Generate array of Memory objects with random createdAt timestamps
    - Verify sorted list is monotonically non-increasing
    - _Requirements: 1.2_
  
  - [x] 2.4 Write unit tests for search and list routes
    - Test MEMORY_ENABLED=false returns 503
    - Test circuit breaker Open returns 502 with metrics
    - Test missing workspaceId returns 400
    - Test successful search calls client.recall correctly
    - Test successful list returns correct response shape
    - _Requirements: 1.1, 1.2, 1.7, 1.8, 1.9_

- [x] 3. Implement memory CRUD routes
  - [x] 3.1 Implement GET /api/memory/:id route handler
    - Parse id param from URL
    - Apply shared guards (skip workspaceId validation for single-item GET)
    - Call client.get(id)
    - Return Memory object or 404 if not found
    - _Requirements: 1.3, 1.7, 1.8_
  
  - [x] 3.2 Implement PATCH /api/memory/:id route handler
    - Parse id from URL and { text: string } from request body
    - Apply shared guards
    - Call client.retain with updated text (replace operation)
    - Return updated Memory object
    - _Requirements: 1.4, 1.7, 1.8, 1.9_
  
  - [x] 3.3 Implement DELETE /api/memory/:id route handler
    - Parse id from URL
    - Apply shared guards
    - Call client.delete(id)
    - Return 204 on success, 404 if not found
    - _Requirements: 1.5, 1.7, 1.8, 1.9_
  
  - [x] 3.4 Write unit tests for CRUD routes
    - Test GET :id returns Memory or 404
    - Test PATCH :id updates text via client.retain
    - Test DELETE :id calls client.delete and returns 204
    - Test all routes respect shared guards
    - _Requirements: 1.3, 1.4, 1.5, 1.7, 1.8, 1.9_

- [x] 4. Implement reflect route
  - [x] 4.1 Implement POST /api/memory/reflect route handler
    - Parse { topic: string, workspaceId: string } from request body
    - Apply shared guards
    - Call client.reflect(topic, workspaceId)
    - Return { reflection: string | null }
    - _Requirements: 1.6, 1.7, 1.8, 1.9_
  
  - [x] 4.2 Write unit tests for reflect route
    - Test successful reflection returns { reflection: string }
    - Test null reflection returns { reflection: null }
    - Test missing topic or workspaceId returns 400
    - Test shared guards apply correctly
    - _Requirements: 1.6, 1.7, 1.8, 1.9_

- [x] 5. Checkpoint — Ensure route tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Create memory page dashboard component
  - [x] 6.1 Implement memory page structure and tab navigation
    - Create `src/dashboard/pages/memory.ts` with `renderMemoryPage(): string`
    - Render header with Timeline/Graph tabs (role="tablist", ARIA attributes)
    - Render tabpanel containers with correct aria-labelledby and aria-controls
    - Implement tab switching keyboard navigation (Arrow keys, Home, End)
    - _Requirements: 2.1, 3.1_
  
  - [x] 6.2 Implement timeline view scope filter bar
    - Render workspace dropdown, chain filter, agent filter dropdowns
    - Wire change handlers to update AppState memory slice
    - Trigger GET /api/memory/list on filter change
    - _Requirements: 2.2_
  
  - [x] 6.3 Implement debounced search input
    - Render search input with aria-label
    - Implement 300ms debounce on input event
    - Trigger GET /api/memory/search on debounced query
    - Clear search and return to list view when input cleared
    - _Requirements: 2.3_
  
  - [x] 6.4 Implement memory card rendering
    - Create `renderMemoryCard(memory: Memory): string` helper
    - Render text excerpt (max 200 chars, ellipsised via clampText helper)
    - Render scope pills using memory.scope fields
    - Implement scoreClass helper mapping score to 'high'/'medium'/'low' CSS class
    - Render quality score badge with aria-label and colour-coded class
    - Render relative timestamp with <time datetime> element
    - Render Edit/Delete action buttons with aria-labels
    - Pass ALL dynamic content through esc() utility
    - _Requirements: 2.5, 2.10_
  
  - [x] 6.5 Write property test for XSS escaping in memory cards
    - **Property 5: Memory card text rendering escapes HTML metacharacters**
    - **Validates: Requirements 2.10**
    - Generate strings containing <, >, &, ", ' characters
    - Verify rendered HTML does not contain unescaped metacharacters
    - _Requirements: 2.10_
  
  - [x] 6.6 Write property test for score badge exhaustiveness
    - **Property 6: Quality score badge colour classification is exhaustive**
    - **Validates: Requirements 2.5**
    - Test scores in [0.0, 1.0] all map to exactly one of high/medium/low
    - _Requirements: 2.5_

- [ ] 7. Implement memory card interactions
  - [~] 7.1 Implement edit interaction
    - Add click handler on Edit button to replace card body with <textarea>
    - Pre-fill textarea with full memory.text
    - Render Save/Cancel buttons
    - Save calls PATCH /api/memory/:id, updates card on success
    - Cancel restores original card HTML
    - _Requirements: 2.6_
  
  - [~] 7.2 Implement delete interaction with confirmation and loading state
    - Add click handler on Delete button showing confirmation tooltip
    - Render "Delete this memory?" with Confirm/Cancel buttons
    - On Confirm click, show loading state (spinner, reduced opacity, disabled buttons)
    - Call DELETE /api/memory/:id
    - On success, remove card from DOM with card.remove()
    - Implement retry logic: if DOM removal throws, retry once after 50ms
    - If retry fails, fall back to location.reload()
    - _Requirements: 2.7, 2.8, 2.9_
  
  - [~] 7.3 Write unit tests for card interactions
    - Test edit flow replaces card with textarea and restores on cancel
    - Test delete shows loading state before API call
    - Test successful delete removes card from DOM
    - Test delete retry logic on DOM removal failure
    - Test fallback reload on double DOM removal failure
    - _Requirements: 2.6, 2.7, 2.8, 2.9_

- [ ] 8. Implement timeline list loading and pagination
  - [ ] 8.1 Implement initial timeline load
    - On page mount, check if search active or default list view
    - Default view: call GET /api/memory/list with current filters
    - Render memory cards ONLY after API success
    - On API failure, show error state with "Failed to load memories" and Retry button
    - _Requirements: 2.4_
  
  - [ ] 8.2 Implement "Load more" pagination
    - Render "Load more" button at bottom of timeline when nextCursor !== null
    - On click, call GET /api/memory/list with cursor from previous response
    - Append new memory cards to existing list
    - Hide button when nextCursor is null (reached end)
    - _Requirements: 2.4_
  
  - [ ] 8.3 Write unit tests for timeline loading
    - Test default view waits for API before rendering cards
    - Test API failure shows error state with retry
    - Test pagination appends cards correctly
    - Test Load more button hides when no more pages
    - _Requirements: 2.4_

- [ ] 9. Checkpoint — Ensure memory page tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Create memory graph component
  - [ ] 10.1 Implement graph data derivation
    - Create `buildGraphData(memories: Memory[]): { entities: GraphEntity[], relations: GraphRelation[] }`
    - Parse memory.text to extract entity names mentioned
    - Build unique entity list with type classification (primary/secondary)
    - Build relation list from entity co-occurrences
    - _Requirements: 3.1_
  
  - [ ] 10.2 Implement graph rendering with empty state guard
    - Create `src/dashboard/pages/memory-graph.ts` with `renderMemoryGraph(entities, relations): string`
    - Check if entities.length < 3, render empty state: "Not enough data to display graph"
    - Empty state container has role="application", tabindex="0", correct aria-label
    - For valid data, render SVG with role="application", tabindex="0"
    - Render aria-label with entity count: "Memory knowledge graph with N entities"
    - _Requirements: 3.1, 3.3, 3.7_
  
  - [ ] 10.3 Write property test for graph aria-label accuracy
    - **Property 7: Graph aria-label reflects entity count accurately**
    - **Validates: Requirements 3.3**
    - Generate arrays of GraphEntity with varying lengths
    - Verify aria-label contains exact entity count
    - _Requirements: 3.3_

- [ ] 11. Implement graph nodes and edges with dual encoding
  - [ ] 11.1 Render entity nodes with shape and colour dual encoding
    - Render primary nodes as <circle r="12"> with fill="var(--accent)"
    - Render secondary nodes as <polygon points="..."> (diamond) with fill="var(--text-muted)"
    - Add <text> labels with minimum 4.5:1 contrast ratio against SVG background
    - Each node <g> has data-node-id, role="button", aria-label="Entity: <name>"
    - _Requirements: 3.5, 3.6_
  
  - [ ] 11.2 Render relation edges
    - Render <line> or <path> elements between related entity nodes
    - Add aria-hidden="true" to edges (relationships listed in sr-only table)
    - _Requirements: 3.1_
  
  - [ ] 11.3 Write unit tests for node rendering
    - Test primary nodes render as circles with --accent fill
    - Test secondary nodes render as diamonds with --text-muted fill
    - Test text labels meet 4.5:1 contrast requirement
    - _Requirements: 3.5, 3.6_

- [ ] 12. Implement graph keyboard navigation
  - [ ] 12.1 Implement Tab navigation and focus management
    - Add tabindex="0" to each node <g> element
    - Implement Tab/Shift+Tab navigation moving between nodes
    - Track focused node in closure state
    - Add visual focus indicator (outline) on node <g>:focus
    - _Requirements: 3.2_
  
  - [ ] 12.2 Implement Enter/Escape expand/collapse
    - Add aria-expanded="false" initial state to each node
    - On Enter keydown, toggle aria-expanded, render inline relation tooltip
    - Tooltip lists related entity names and relation labels
    - On Escape keydown, collapse active node (aria-expanded="false")
    - _Requirements: 3.2_
  
  - [ ] 12.3 Write unit tests for keyboard navigation
    - Test Tab moves focus between nodes
    - Test Enter toggles aria-expanded and shows tooltip
    - Test Escape collapses active node
    - Test focus indicator applied correctly
    - _Requirements: 3.2_

- [ ] 13. Implement sr-only accessibility table
  - [ ] 13.1 Render sr-only table alongside SVG
    - Create <table class="sr-only" id="memory-graph-table">
    - Add <caption>Memory knowledge graph entities and relationships</caption>
    - Render <thead> with "Entity" and "Relations" columns
    - Render <tbody> with one row per entity
    - Relations column lists comma-separated related entity names
    - SVG has aria-describedby="memory-graph-table"
    - _Requirements: 3.4_
  
  - [ ] 13.2 Write property test for sr-only table completeness
    - **Property 8: sr-only table contains all entity names and relations**
    - **Validates: Requirements 3.4**
    - Generate arrays of GraphEntity and GraphRelation
    - Verify every entity name appears exactly once in table
    - Verify all relations involving each entity appear in its row
    - _Requirements: 3.4_
  
  - [ ] 13.3 Write unit tests for sr-only table
    - Test table row count matches entity array length
    - Test all entity names present in table
    - Test sr-only class applied (CSS verification)
    - _Requirements: 3.4_

- [ ] 14. Implement reflect panel
  - [ ] 14.1 Create reflect panel UI in sidebar
    - Render <aside class="memory-page__sidebar" aria-label="Memory reflection panel">
    - Render <input type="text" placeholder="Enter topic..."> with aria-label
    - Render "Reflect" <button> with aria-label
    - Render result container for reflection text or "No reflection available."
    - _Requirements: 4.1_
  
  - [ ] 14.2 Implement reflect API call with loading state
    - Add click handler on Reflect button
    - Show loading spinner, set button aria-disabled="true"
    - Call POST /api/memory/reflect with topic and workspaceId
    - On success, render reflection text through esc() or "No reflection available." if null
    - On error, show error message in result container
    - Hide spinner, restore button to aria-disabled="false"
    - _Requirements: 4.1, 4.2_
  
  - [ ] 14.3 Write unit tests for reflect panel
    - Test loading state disables button and shows spinner
    - Test successful reflection renders text
    - Test null reflection shows "No reflection available."
    - Test error shows error message
    - Test XSS escaping on reflection text
    - _Requirements: 4.1, 4.2_

- [ ] 15. Implement real-time memory updates via SSE
  - [ ] 15.1 Extend dashboard SSE handler for memory-update events
    - In `src/dashboard/main.ts`, add memory-update case to existing onmessage handler
    - Check if currentPage === 'memory'
    - If yes, call refreshMemoryList() to silently re-fetch GET /api/memory/list
    - Replace timeline cards without full page reload
    - _Requirements: 4.3_
  
  - [ ] 15.2 Implement WeakRef-based listener registry
    - Create _listenerRegistry: Map<string, WeakRef<() => void>>
    - Implement registerMemoryUpdateListener(id, fn) and deregisterMemoryUpdateListener(id)
    - Add 30-second setInterval sweep to remove dead WeakRef entries
    - Call registerMemoryUpdateListener on memory page mount
    - Call deregisterMemoryUpdateListener on memory page unmount
    - _Requirements: 4.4_
  
  - [ ] 15.3 Implement background refresh error handling
    - Wrap refreshMemoryList() in try/catch
    - On error, call enqueueToast with type: 'error', message: 'Memory refresh failed — retrying'
    - Use persistent: false for non-intrusive toast
    - _Requirements: 4.5_
  
  - [ ] 15.4 Write unit tests for SSE integration
    - Test memory-update event triggers refreshMemoryList when on memory page
    - Test memory-update ignored when on different page
    - Test WeakRef registry cleanup removes dead entries
    - Test background refresh error shows toast
    - _Requirements: 4.3, 4.4, 4.5_

- [ ] 16. Extend dashboard types and state
  - [ ] 16.1 Extend Page type and AppState interface
    - In `src/dashboard/types.ts`, add 'memory' to Page union
    - Add MemoryPageState interface with memories, cursor, total, searchQuery, loading, error
    - Add optional memory?: MemoryPageState to AppState
    - _Requirements: 2.1_
  
  - [ ] 16.2 Add G→M keyboard shortcut to main.ts
    - In existing keyboard handler, add case for 'M' after 'G' prefix
    - Set currentPage: 'memory' in state
    - Clear _pendingG counter
    - _Requirements: 2.1_
  
  - [ ] 16.3 Write unit tests for state extensions
    - Test G→M shortcut updates currentPage to 'memory'
    - Test MemoryPageState initializes with correct defaults
    - _Requirements: 2.1_

- [ ] 17. Register memory-browser routes in monitor.ts
  - [ ] 17.1 Wire memory-browser routes into main router
    - Import { register as registerMemoryRoutes } from './routes/memory-browser.ts'
    - Get IMemoryClient and MemoryCircuitBreaker instances from existing infrastructure
    - Call registerMemoryRoutes(router, client, circuitBreaker) in monitor.ts
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_
  
  - [ ] 17.2 Write integration test for route registration
    - Test all 6 memory routes respond correctly after registration
    - Test MEMORY_ENABLED guard applies to all routes
    - Test circuit breaker guard applies to all routes
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

- [ ] 18. Final checkpoint — Ensure all tests pass and build dashboard
  - Run `tsc --noEmit` to verify no type errors
  - Run `bun test test/routes/memory-browser.test.ts` to verify route tests pass
  - Run `bun test test/dashboard/memory-page.test.ts` to verify dashboard tests pass
  - Click the Build button in Monitor Dashboard to rebuild dashboard SPA
  - Hard refresh browser (Ctrl+Shift+R) to load new memory page
  - Test G→M keyboard shortcut navigates to memory page
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at logical boundaries
- Property tests validate universal correctness properties from design
- Unit tests validate specific examples, error cases, and integration points
- All dynamic content MUST pass through esc() utility for XSS prevention
- All routes MUST apply shared guards in order: feature flag → circuit breaker → workspaceId
- Memory page follows pure-function contract: renderMemoryPage(): string
- Graph uses dual encoding (shape + colour) to meet WCAG AA requirements
- WeakRef-based listener registry prevents memory leaks from orphaned handlers

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5"] },
    { "id": 2, "tasks": ["2.1", "2.2", "3.1", "4.1"] },
    { "id": 3, "tasks": ["2.3", "2.4", "3.2", "3.3", "3.4", "4.2"] },
    { "id": 4, "tasks": ["6.1", "6.2", "10.1"] },
    { "id": 5, "tasks": ["6.3", "6.4", "10.2", "10.3"] },
    { "id": 6, "tasks": ["6.5", "6.6", "7.1", "11.1", "11.2"] },
    { "id": 7, "tasks": ["7.2", "7.3", "8.1", "11.3", "12.1", "13.1"] },
    { "id": 8, "tasks": ["8.2", "8.3", "12.2", "13.2", "13.3", "14.1"] },
    { "id": 9, "tasks": ["12.3", "14.2", "14.3", "15.1", "16.1"] },
    { "id": 10, "tasks": ["15.2", "15.3", "16.2"] },
    { "id": 11, "tasks": ["15.4", "16.3", "17.1"] },
    { "id": 12, "tasks": ["17.2"] }
  ]
}
```
