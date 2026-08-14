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
7. All routes return 503 with `{ error: 'memory disabled' }` when `MEMORY_ENABLED=false`.
8. All routes return 503 with `{ error: 'circuit open', metrics: CircuitBreakerMetrics }`
   when the circuit breaker is in the Open state.
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
4. The default view (no search) loads the first page from `GET /api/memory/list` and renders
   50 memory cards per page. A "Load more" button appends the next page.
5. Each memory card shows: text excerpt (max 200 chars, ellipsised), scope tags as pills,
   quality score badge (colour-coded: green ≥ 0.85, amber ≥ 0.65, red < 0.65), relative
   timestamp, and Edit / Delete action buttons.
6. Edit opens an inline `<textarea>` pre-filled with the full memory text; Save calls
   `PATCH /api/memory/:id`; Cancel restores the card.
7. Delete shows a confirmation tooltip ("Delete this memory?") before calling
   `DELETE /api/memory/:id`.
8. After a successful delete the card is removed from the DOM without a full page reload.
9. All text rendered in memory cards passes through the existing `esc()` utility to prevent
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
7. The graph is not rendered if the workspace has fewer than 3 entity nodes — the tab shows
   "Not enough data to display graph" instead.

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
4. The memory page registers and deregisters its WebSocket listener on mount and unmount
   respectively to avoid duplicate handlers.
5. If `GET /api/memory/list` returns an error during a background refresh, a non-intrusive
   toast notification is shown ("Memory refresh failed — retrying") using the existing
   `enqueueToast` mechanism.
