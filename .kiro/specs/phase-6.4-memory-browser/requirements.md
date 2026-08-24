# Requirements Document

## Introduction

Phase 6.4 adds a Memory browser page to the AgentHQ dashboard. Developers can search, view,
edit, and delete memories, inspect Hindsight reflections on a topic, and see memory entity
relationships in a navigable graph. All UI components meet WCAG 2.1 AA accessibility standards.

**Prerequisite:** Phase 6.3 complete. Memory is being extracted and injected.
The REST routes in this phase depend on `IMemoryClient` from Phase 6.1.

---

## Glossary

| Term | Definition |
|------|-----------|
| **Memory page** | The new fifth page in the dashboard SPA, accessible at `G → M`. |
| **Memory timeline** | Chronological paginated list of memories with scope tags and quality scores. |
| **Memory graph** | SVG/canvas visualisation of entity relationships extracted from memories. |
| **Reflect panel** | Shows Hindsight's synthesised reflection for a chosen topic within the current workspace. |
| **WCAG AA** | Web Content Accessibility Guidelines 2.1 Level AA — minimum 4.5:1 text contrast, 3:1 UI contrast. |

---

## Requirements

### Requirement 1: Memory REST Routes

**User Story:** As a developer, I want REST endpoints for memory search, CRUD, and reflection
so that the dashboard can present a complete management interface.

#### Acceptance Criteria

1. `GET /api/memory/search?q=<query>&workspaceId=<id>&limit=<n>` calls `client.recall` and
   returns `Memory[]`. Default limit is 20, maximum is 100.
2. `GET /api/memory/list?workspaceId=<id>&cursor=<id>&pageSize=50` returns a cursor-paginated
   list of memories sorted by `createdAt DESC`. Response shape:
   `{ memories: Memory[], nextCursor: string | null, total: number }`.
3. `GET /api/memory/:id` returns a single `Memory` or 404.
4. `PATCH /api/memory/:id` accepts `{ text: string }` and updates the memory text via a
   Hindsight `retain` (replace). Returns the updated `Memory`.
5. `DELETE /api/memory/:id` calls `client.delete(id)` and returns 204.
6. `POST /api/memory/reflect` accepts `{ topic: string, workspaceId: string }` and calls
   `client.reflect`. Returns `{ reflection: string | null }`.
7. WHEN `MEMORY_ENABLED=false`, ALL memory routes except health/debug endpoints SHALL
   return 503 with `{ error: 'memory disabled' }`. Health and debug routes (e.g.,
   `/api/memory/health`) SHALL continue to work normally even when memory is disabled,
   allowing operational monitoring without enabling the full memory system.
8. WHEN the circuit breaker is in the Open state, THE SYSTEM SHALL return 502 with
   `{ error: 'circuit open', metrics: CircuitBreakerMetrics }` to distinguish circuit
   breaker failures from memory-disabled state. Database connectivity failures SHALL
   return 504 with `{ error: 'database timeout' }`. Other upstream service failures
   SHALL return 502 with appropriate error messages.
9. `workspaceId` is validated as a non-empty string on every route; missing or empty returns
   400 with `{ error: 'workspaceId required' }`.

### Requirement 2: Memory Page — Timeline View

**User Story:** As a developer, I want a paginated list of memories so that I can browse
everything the system has learned about my workspace.

#### Acceptance Criteria

1. `src/dashboard/pages/memory.ts` exports `renderMemoryPage(): string` following the same
   pure-function contract as all other dashboard pages.
2. The page renders a scope filter bar (workspace dropdown, chain filter, agent filter) at
   the top.
3. Below the filters, a search input with debounce (300 ms) triggers
   `GET /api/memory/search` and replaces the timeline with results.
4. WHEN the memory page loads in default view (no search active), THE SYSTEM SHALL call
   `GET /api/memory/list` and render memory cards only after the API call succeeds.
   IF the API call fails, THE SYSTEM SHALL show an error state with a retry prompt instead
   of rendering cards. A "Load more" button appends subsequent pages.
5. Each memory card shows: text excerpt (max 200 chars, ellipsised), scope tags as pills,
   quality score badge (colour-coded: green ≥ 0.85, amber ≥ 0.65, red < 0.65), relative
   timestamp, and Edit / Delete action buttons.
6. Edit opens an inline `<textarea>` pre-filled with the full memory text; Save calls
   `PATCH /api/memory/:id`; Cancel restores the card.
7. Delete shows a confirmation tooltip ("Delete this memory?") before calling
   `DELETE /api/memory/:id`.
8. WHEN the delete button is clicked after confirmation, THE SYSTEM SHALL immediately
   display a loading state on the card (spinner or disabled appearance with reduced
   opacity) while the `DELETE /api/memory/:id` call is in progress.
9. WHEN the delete API call succeeds, THE SYSTEM SHALL remove the card from the DOM
   without a full page reload. IF the DOM removal fails due to a JavaScript error
   after a successful delete, THE SYSTEM SHALL automatically retry the DOM removal once.
   IF the retry also fails, THE SYSTEM SHALL fall back to a full page reload to ensure
   the deleted memory is no longer visible and the UI remains synchronized with the
   backend state.
10. All text rendered in memory cards passes through the existing `esc()` utility to prevent
    XSS injection.

### Requirement 3: Memory Graph View

**User Story:** As a developer, I want a graph visualisation of entity relationships so that
I can understand how concepts in my workspace are connected in the memory store.

#### Acceptance Criteria

1. A "Graph" tab on the memory page renders an SVG force-directed graph of entity nodes and
   relation edges derived from the current workspace's memories.
2. Entity nodes are keyboard-navigable: `Tab` / `Shift+Tab` moves between nodes; `Enter`
   expands a node to show its relations; `Escape` collapses.
3. The graph container has `role="application"`, `tabindex="0"`, and an `aria-label` of
   `"Memory knowledge graph with N entities"` where N is the node count.
4. A visually-hidden `<table>` with `class="sr-only"` is rendered alongside the SVG,
   listing all entity names and their relations — accessible to screen readers, invisible
   to sighted users.
5. Entity node colours use `var(--accent)` for primary nodes and `var(--text-muted)` for
   secondary. No information is conveyed by colour alone — node type is also indicated
   by shape (circle vs diamond).
6. All text elements in the SVG graph have a minimum contrast ratio of 4.5:1 against the
   SVG background colour.
7. WHEN the workspace has fewer than 3 entity nodes, THE SYSTEM SHALL render an empty SVG
   container that satisfies all accessibility requirements (role, tabindex, aria-label) but
   contains no nodes or edges, and SHALL display the message "Not enough data to display
   graph" inside the container in place of graph content.

### Requirement 4: Reflect Panel and Real-time Updates

**User Story:** As a developer, I want to ask Hindsight for a synthesised reflection on a
topic and see new memories appear in real-time so that the browser is always current.

#### Acceptance Criteria

1. A "Reflect" panel in the sidebar accepts a free-text topic input and a "Reflect" button.
   On click it calls `POST /api/memory/reflect` and renders the returned reflection string
   below the input, or "No reflection available." if `null`.
2. The reflect call shows a loading spinner while in-flight and disables the button to
   prevent duplicate submissions.
3. When a `memory-update` WebSocket event arrives with the current workspace ID, the
   timeline list is refreshed via a silent `GET /api/memory/list` call — no full page
   reload, no visible flicker.
4. WHEN a reflection operation begins on the memory page, THE SYSTEM SHALL register the
   WebSocket listener if not already registered. THE SYSTEM SHALL deregister the listener
   on page unmount. IF a component unmounts unexpectedly without proper deregistration,
   THE SYSTEM SHALL employ a failsafe cleanup mechanism (e.g., a WeakRef-based registry
   or periodic sweep) to detect and remove orphaned listeners, preventing duplicate
   handler accumulation.
5. If `GET /api/memory/list` returns an error during a background refresh, a non-intrusive
   toast notification is shown ("Memory refresh failed — retrying") using the existing
   `enqueueToast` mechanism.
