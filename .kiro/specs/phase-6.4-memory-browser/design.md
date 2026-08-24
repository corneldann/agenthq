# Design Document

## Overview

Phase 6.4 adds a Memory browser page to the AgentHQ dashboard — a fifth SPA page reachable
via `G → M`. It surfaces the memory infrastructure built in Phase 6.1 (storage, circuit
breaker, IMemoryClient) and Phase 6.3 (context assembly) through a REST API layer and a
browser UI with timeline, graph, and reflection panels.

**Objectives:**
- Six new REST routes (`/api/memory/*`) backed by the existing `IMemoryClient` interface
- `renderMemoryPage()` — a pure-function dashboard page following the existing component contract
- WCAG 2.1 AA accessibility for all UI components (keyboard navigation, ARIA, contrast)
- XSS prevention via the existing `esc()` utility for all dynamic content
- Real-time updates via the existing SSE/WebSocket infrastructure

---

## Architecture

### Layer Overview

```
Browser (SPA)                          Bun HTTP Server
─────────────────────────────────────  ────────────────────────────────────────
renderMemoryPage()                     src/routes/memory-browser.ts
  ├─ Timeline tab                        register(router, client, breaker)
  │    ├─ scope filter bar                 GET /api/memory/search
  │    ├─ debounced search                 GET /api/memory/list
  │    └─ memory cards                     GET /api/memory/:id
  ├─ Graph tab                             PATCH /api/memory/:id
  │    ├─ SVG force-directed graph         DELETE /api/memory/:id
  │    └─ sr-only table fallback           POST /api/memory/reflect
  └─ Reflect panel (sidebar)
                                       src/memory/types.ts (IMemoryClient)
Dashboard SPA bootstrap (main.ts)        └─ MemoryCircuitBreaker wraps it
  ├─ G→M keyboard shortcut
  ├─ Page type extended with 'memory'
  └─ SSE: memory-update event handling
```

### Existing Infrastructure Re-Used

| Component | Location | Re-use in Phase 6.4 |
|-----------|----------|----------------------|
| `IMemoryClient` | `src/memory/types.ts` | All route handlers call through this interface |
| `MemoryCircuitBreaker` | `src/memory/circuit-breaker.ts` | Wraps client; routes detect Open state → 502 |
| `MEMORY_ENABLED` | `src/constants.ts` | Guard on all new browser routes |
| `esc()` | `src/dashboard/utils.ts` | All dynamic strings in memory page HTML |
| `enqueueToast` | `src/dashboard/toast.ts` | Error toasts for failed background refreshes |
| `el()` | `src/dashboard/utils.ts` | DOM element construction in memory page |
| `getState() / setState()` | `src/dashboard/state.ts` | Memory page state slice added |
| SSE `EventSource` | `src/dashboard/main.ts` | `memory-update` event added to existing listener |

### New Files

| File | Purpose |
|------|---------|
| `src/routes/memory-browser.ts` | REST route handlers for the 6 new endpoints |
| `src/dashboard/pages/memory.ts` | `renderMemoryPage()` pure function |
| `src/dashboard/pages/memory-graph.ts` | SVG force-directed graph rendering logic |
| `test/routes/memory-browser.test.ts` | Unit tests for route handlers |
| `test/dashboard/memory-page.test.ts` | Unit tests for memory page rendering |

---

## Components and Interfaces

### 1. REST Route Module — `src/routes/memory-browser.ts`

```typescript
export function register(
  router: Router,
  client: IMemoryClient,
  circuitBreaker: MemoryCircuitBreaker,
): void
```

The module registers six routes. All routes share a common request-handling pattern:

1. **Feature flag guard** — if `MEMORY_ENABLED=false`, return 503 immediately (except health).
2. **Circuit state guard** — if breaker is Open, return 502 with `CircuitBreakerMetrics`.
3. **Input validation** — validate `workspaceId` (non-empty string); return 400 if missing.
4. **Delegate to `IMemoryClient`** — call the appropriate method.
5. **Error mapping** — catch errors from the client and map to HTTP status codes.

**Error mapping table:**

| Error type | HTTP status | Body |
|------------|-------------|------|
| `MEMORY_ENABLED=false` | 503 | `{ error: 'memory disabled' }` |
| Circuit breaker Open | 502 | `{ error: 'circuit open', metrics: CircuitBreakerMetrics }` |
| DB connectivity timeout | 504 | `{ error: 'database timeout' }` |
| Other upstream failure | 502 | `{ error: string }` |
| Missing/empty `workspaceId` | 400 | `{ error: 'workspaceId required' }` |
| Memory not found | 404 | `{ error: 'not found' }` |

**Limit resolution helper** (pure function, independently testable):

```typescript
function resolveLimit(raw: string | null, defaultVal: number, max: number): number {
  if (raw === null) return defaultVal;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(n, max);
}
// resolveLimit(null, 20, 100)   → 20  (default)
// resolveLimit('50', 20, 100)   → 50
// resolveLimit('200', 20, 100)  → 100 (clamped)
```

### 2. Memory Page — `src/dashboard/pages/memory.ts`

Follows the same pure-function contract as all existing pages:

```typescript
export function renderMemoryPage(): string
```

Returns an HTML string. Called from `renderPage()` in `main.ts` when
`currentPage === 'memory'`. Mounts event listeners via a `DOMContentLoaded`-style
pattern after `innerHTML` assignment (same as `analytics.ts`).

**Top-level structure:**

```
<div class="memory-page">
  <header class="memory-page__header">
    <div class="memory-page__tabs" role="tablist">
      <button role="tab" aria-selected="true"  id="tab-timeline" aria-controls="panel-timeline">Timeline</button>
      <button role="tab" aria-selected="false" id="tab-graph"    aria-controls="panel-graph">Graph</button>
    </div>
  </header>
  <div class="memory-page__body">
    <div role="tabpanel" id="panel-timeline" aria-labelledby="tab-timeline">
      <!-- scope filter bar -->
      <!-- search input -->
      <!-- memory card list -->
      <!-- Load more button -->
    </div>
    <div role="tabpanel" id="panel-graph" aria-labelledby="tab-graph" hidden>
      <!-- SVG graph / empty state -->
      <!-- sr-only table -->
    </div>
  </div>
  <aside class="memory-page__sidebar" aria-label="Memory reflection panel">
    <!-- Reflect panel -->
  </aside>
</div>
```

**Memory card HTML skeleton** (all dynamic values pass through `esc()`):

```html
<article class="memory-card" data-memory-id="${esc(memory.id)}">
  <div class="memory-card__body">
    <p class="memory-card__text">${esc(clampText(memory.text, 200))}</p>
    <div class="memory-card__meta">
      ${scopePills}
      <span class="memory-card__score memory-card__score--${scoreClass}"
            aria-label="Quality score ${memory.qualityScore}">
        ${memory.qualityScore.toFixed(2)}
      </span>
      <time class="memory-card__time" datetime="${esc(memory.createdAt)}">
        ${esc(relativeTime(memory.createdAt))}
      </time>
    </div>
  </div>
  <div class="memory-card__actions">
    <button class="memory-card__btn memory-card__btn--edit"
            aria-label="Edit memory">Edit</button>
    <button class="memory-card__btn memory-card__btn--delete"
            aria-label="Delete memory">Delete</button>
  </div>
</article>
```

Quality score CSS class mapping:

| Range | Class | Colour token |
|-------|-------|-------------|
| `>= 0.85` | `memory-card__score--high` | `var(--cg)` (green) |
| `>= 0.65` | `memory-card__score--medium` | `var(--cy)` (amber) |
| `< 0.65` | `memory-card__score--low` | `var(--cr)` (red) |

### 3. Memory Graph — `src/dashboard/pages/memory-graph.ts`

```typescript
export type GraphEntity = { id: string; name: string; type: 'primary' | 'secondary' };
export type GraphRelation = { from: string; to: string; label: string };

export function renderMemoryGraph(
  entities: GraphEntity[],
  relations: GraphRelation[],
): string
```

Returns an HTML string containing both the SVG and the `sr-only` table.

**Insufficient data guard:** when `entities.length < 3`, renders:

```html
<div class="memory-graph__empty" role="application" tabindex="0"
     aria-label="Memory knowledge graph with 0 entities">
  <p>Not enough data to display graph</p>
</div>
```

**Full graph structure:**

```html
<div class="memory-graph">
  <svg class="memory-graph__svg" role="application" tabindex="0"
       aria-label="Memory knowledge graph with N entities"
       aria-describedby="memory-graph-table">
    <!-- <circle> for primary nodes (type="primary") -->
    <!-- <polygon> for secondary nodes (type="secondary", diamond shape) -->
    <!-- <line> or <path> for relation edges -->
    <!-- <text> labels — minimum 4.5:1 contrast on SVG background -->
  </svg>
  <table class="sr-only" id="memory-graph-table" aria-label="Memory entity relationships">
    <caption>Memory knowledge graph entities and relationships</caption>
    <thead><tr><th>Entity</th><th>Relations</th></tr></thead>
    <tbody>
      <!-- one row per entity, relations column lists related entity names -->
    </tbody>
  </table>
</div>
```

**Node type dual-encoding:**

| Node type | Shape | CSS fill |
|-----------|-------|----------|
| `primary` | `<circle r="12">` | `var(--accent, #3b82f6)` |
| `secondary` | `<polygon points="…">` (diamond) | `var(--md-on-surf-var, #9e9ea4)` |

No information is conveyed by colour alone — shape is the primary discriminator.

**Keyboard navigation (Tab/Shift+Tab/Enter/Escape):**

Implemented via `data-node-id` attributes and a focus manager attached after mount.
Each SVG node group (`<g>`) receives `tabindex="0"`, `role="button"`,
`aria-label="Entity: <name>"`, and `aria-expanded="false"`.
`Enter` toggles `aria-expanded` and renders an inline relation tooltip.
`Escape` collapses the active node.

### 4. Reflect Panel

Rendered inside the sidebar `<aside>`. State is local to the page module (not in
global AppState) — a plain object held in a closure:

```typescript
type ReflectState = {
  loading: boolean;
  reflection: string | null;
  error: string | null;
};
```

The "Reflect" button is disabled (`aria-disabled="true"`) while `loading === true`.
Result text is rendered through `esc()` before insertion.

### 5. Dashboard SPA Extensions

**`src/dashboard/types.ts`** — extend `Page` and `AppState`:

```typescript
export type Page = 'dashboard' | 'work' | 'activity' | 'analytics' | 'memory';

// Memory page state slice
export type MemoryPageState = {
  memories: Memory[];           // currently loaded timeline memories
  cursor: string | null;        // pagination cursor for "Load more"
  total: number;                // total count from /api/memory/list
  searchQuery: string;          // current search query ('' = default list view)
  loading: boolean;
  error: string | null;
};
```

The `AppState` interface gains an optional `memory` slice populated lazily:

```typescript
memory?: MemoryPageState;
```

**`src/dashboard/main.ts`** — extend keyboard shortcuts and SSE:

```typescript
// G → M shortcut
if (key === 'M') {
  setState({ currentPage: 'memory' });
  _pendingG = 0;
  return;
}

// memory-update SSE event
// In the existing onmessage handler, add:
if (parsed.type === 'memory-update') {
  // Re-fetch memory list silently if memory page is active
  const { currentPage } = getState();
  if (currentPage === 'memory') {
    void refreshMemoryList().catch(() => {
      enqueueToast({
        id: crypto.randomUUID(),
        type: 'error',
        message: 'Memory refresh failed — retrying',
        persistent: false,
      });
    });
  }
}
```

**WebSocket listener lifecycle (Requirement 4.4):**

A `WeakRef`-based registry is used to track active memory page listener instances.
When `renderMemoryPage()` mounts, it registers the `memory-update` handler in the
registry. A periodic sweep (every 30 s) walks the registry and removes dead entries
(those whose `WeakRef.deref()` returns `undefined`). Page unmount explicitly calls
`deregisterMemoryUpdateListener()`. This prevents duplicate handler accumulation
even if the component unmounts unexpectedly.

```typescript
const _listenerRegistry = new Map<string, WeakRef<() => void>>();

function registerMemoryUpdateListener(id: string, fn: () => void): void {
  _listenerRegistry.set(id, new WeakRef(fn));
}

function deregisterMemoryUpdateListener(id: string): void {
  _listenerRegistry.delete(id);
}

setInterval(() => {
  for (const [id, ref] of _listenerRegistry) {
    if (ref.deref() === undefined) _listenerRegistry.delete(id);
  }
}, 30_000);
```

---

## Data Models

### `Memory` (from `src/memory/types.ts`, unchanged)

```typescript
type Memory = {
  id: string;
  text: string;
  scope: MemoryScope;         // { workspaceId, userId?, agentId?, runId?, chainId? }
  qualityScore: number;       // 0.0–1.0
  createdAt: string;          // ISO 8601
  lastRetrievedAt: string;    // ISO 8601
  retrievalCount: number;
  tier: 'hot' | 'warm' | 'cold';
  embeddingStatus: 'pending' | 'ready' | 'failed';
};
```

### GET /api/memory/list Response

```typescript
type MemoryListResponse = {
  memories: Memory[];
  nextCursor: string | null;
  total: number;
};
```

### POST /api/memory/reflect Request / Response

```typescript
// Request body
type ReflectRequest = { topic: string; workspaceId: string };

// Response body
type ReflectResponse = { reflection: string | null };
```

### GraphEntity / GraphRelation (client-side derived from Memory[])

```typescript
type GraphEntity = { id: string; name: string; type: 'primary' | 'secondary' };
type GraphRelation = { from: string; to: string; label: string };
```

Graph data is derived client-side from the memory set by parsing entity names mentioned
in memory text (this is a display-only approximation; the authoritative relationship store
is in the Hindsight MCP server). The derivation runs in `buildGraphData(memories: Memory[])`.

### Error Response Shape

```typescript
type ErrorResponse = { error: string; metrics?: CircuitBreakerMetrics };
```

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions
of a system — essentially, a formal statement about what the system should do. Properties
serve as the bridge between human-readable specifications and machine-verifiable correctness
guarantees.*

### Property 1: Limit resolution clamps to valid range

*For any* raw limit string and any (default, max) configuration pair, the resolved limit
is always within `[1, max]` and equals `defaultVal` when the input is absent or invalid.

**Validates: Requirements 1.1**

### Property 2: Memory list is sorted descending by createdAt

*For any* non-empty array of `Memory` objects returned by `/api/memory/list`, each
element's `createdAt` timestamp is greater than or equal to the `createdAt` timestamp
of all subsequent elements — i.e., the list is monotonically non-increasing by creation time.

**Validates: Requirements 1.2**

### Property 3: MEMORY_ENABLED=false guard applies to all protected routes

*For any* route in the protected set (`/api/memory/search`, `/api/memory/list`,
`/api/memory/:id` GET/PATCH/DELETE, `/api/memory/reflect`), when `MEMORY_ENABLED=false`,
the response status is 503 and the body contains `{ error: 'memory disabled' }`.
Health and debug routes are excluded from this property.

**Validates: Requirements 1.7**

### Property 4: workspaceId validation is consistent across all routes

*For any* protected memory route and *for any* request where `workspaceId` is absent,
an empty string, or a string composed entirely of whitespace characters, the response
status is always 400 and the body always contains `{ error: 'workspaceId required' }`.

**Validates: Requirements 1.9**

### Property 5: Memory card text rendering escapes HTML metacharacters

*For any* `Memory` object whose `text` field contains HTML metacharacters (`<`, `>`, `&`,
`"`, `'`), the rendered memory card HTML does not contain an unescaped occurrence of those
characters in any dynamically inserted position. The only occurrences of `<` and `>` in
the output are from the HTML template structure itself.

**Validates: Requirements 2.10**

### Property 6: Quality score badge colour classification is exhaustive

*For any* `qualityScore` in the range `[0.0, 1.0]`, the rendered card's score badge
receives exactly one of the three CSS modifier classes: `--high` (score ≥ 0.85),
`--medium` (score ≥ 0.65 and < 0.85), or `--low` (score < 0.65). No valid score maps
to an absent or unknown class.

**Validates: Requirements 2.5**

### Property 7: Graph aria-label reflects entity count accurately

*For any* array of `GraphEntity` objects passed to `renderMemoryGraph()`, the rendered
SVG container's `aria-label` attribute contains the exact integer count of those entities
(i.e., `entities.length`), formatted as `"Memory knowledge graph with N entities"`.

**Validates: Requirements 3.3**

### Property 8: sr-only table contains all entity names and relations

*For any* set of `GraphEntity` and `GraphRelation` objects, every entity name appears
exactly once as a table row heading in the `sr-only` table, and every relation involving
that entity appears in its relations column. No entity is omitted.

**Validates: Requirements 3.4**

---

## Error Handling

### Failure Modes and Recovery

**MEMORY_ENABLED=false**
- **Detection:** `MEMORY_ENABLED` constant checked at route handler entry.
- **Response:** Return 503 `{ error: 'memory disabled' }` immediately; skip client call.
- **Recovery:** N/A — this is a configuration state, not a transient failure.

**Circuit Breaker Open**
- **Detection:** `circuitBreaker.getMetrics().state === 'open'` checked before delegating.
- **Response:** Return 502 `{ error: 'circuit open', metrics: CircuitBreakerMetrics }`.
  The metrics payload lets clients distinguish this from a generic 502.
- **Recovery:** Breaker transitions to `half_open` automatically after `openTimeoutMs`.
  The dashboard shows the circuit state in a status badge on the memory page.

**Database Timeout**
- **Detection:** `IMemoryClient` throws `MemoryTimeoutError` (from `src/memory/errors.ts`).
- **Response:** Return 504 `{ error: 'database timeout' }`.
- **Recovery:** Transient — client may retry with exponential back-off.

**Other Upstream Service Failure**
- **Detection:** `IMemoryClient` throws `MemoryServiceError` or unknown error.
- **Response:** Return 502 `{ error: string }` with the error message.
- **Recovery:** Transient — circuit breaker counts tripping errors toward threshold.

**Background Memory List Refresh Failure (client-side)**
- **Detection:** `GET /api/memory/list` returns non-2xx during SSE-triggered refresh.
- **Response:** Non-intrusive toast: `"Memory refresh failed — retrying"` via `enqueueToast`.
- **Recovery:** No automatic retry on background refresh; user can manually reload.

**DOM Removal Failure After Delete**
- **Detection:** `card.remove()` throws in the delete success handler.
- **Response:** Retry DOM removal once after a 50 ms delay.
- **Recovery:** If the retry also throws, call `location.reload()` to resync DOM with server.

**Memory Not Found (PATCH / DELETE / GET :id)**
- **Detection:** `IMemoryClient.delete(id)` throws a 404-equivalent error, or
  `GET /api/memory/:id` returns no result.
- **Response:** Return 404 `{ error: 'not found' }`.
- **Recovery:** Client removes the stale card from the timeline UI.

**WebSocket Listener Leak**
- **Detection:** Periodic 30-second sweep of the `WeakRef` registry finds dead entries.
- **Response:** Delete the dead entry from the registry.
- **Recovery:** Explicit `deregisterMemoryUpdateListener()` on page unmount is the primary
  path; the sweep is a failsafe.

---

## Testing Strategy

### Unit Tests

**`test/routes/memory-browser.test.ts`**

- `resolveLimit()` pure function: parameterized examples for null input, valid range,
  over-max, non-numeric, zero.
- Route handler: `MEMORY_ENABLED=false` returns 503 for each of the 6 routes.
- Route handler: missing `workspaceId` returns 400 for each route.
- Route handler: circuit breaker Open state returns 502 with metrics.
- Route handler: `MemoryTimeoutError` returns 504.
- Route handler: successful `GET /api/memory/search` calls `client.recall` with correct
  arguments and returns 200 with `Memory[]`.
- Route handler: successful `PATCH /api/memory/:id` calls `client.retain` and returns
  updated `Memory`.
- Route handler: `DELETE /api/memory/:id` calls `client.delete` and returns 204.

**`test/dashboard/memory-page.test.ts`**

- `scoreClass()` helper: parameterized examples for 0.0, 0.64, 0.65, 0.84, 0.85, 1.0.
- `renderMemoryCard()`: XSS characters in `text` field are escaped in output.
- `renderMemoryGraph()`: aria-label contains entity count for 0, 1, 2, 5 entities.
- `renderMemoryGraph()`: `entities.length < 3` renders empty state with correct message.
- `renderMemoryGraph()`: sr-only table row count matches entity array length.
- `buildGraphData()`: entity extraction produces unique entity names from memory texts.

### Property-Based Tests (fast-check)

All property tests use `fc.property` with minimum 100 runs.

**Property 1 — `resolveLimit` clamps correctly:**
```typescript
// Feature: phase-6.4-memory-browser, Property 1: limit resolution clamps to valid range
fc.property(
  fc.option(fc.oneof(fc.integer(), fc.string()), { nil: null }),
  fc.integer({ min: 1, max: 50 }),   // defaultVal
  fc.integer({ min: 10, max: 1000 }), // max
  (raw, defaultVal, maxVal) => {
    const rawStr = raw === null ? null : String(raw);
    const result = resolveLimit(rawStr, defaultVal, maxVal);
    return result >= 1 && result <= maxVal;
  }
)
```

**Property 2 — memory list sort order:**
```typescript
// Feature: phase-6.4-memory-browser, Property 2: memory list sorted descending by createdAt
fc.property(
  fc.array(fc.record({ id: fc.uuid(), createdAt: fc.date().map(d => d.toISOString()), text: fc.string() })),
  (memories) => {
    const sorted = sortByCreatedAtDesc(memories);
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].createdAt < sorted[i + 1].createdAt) return false;
    }
    return true;
  }
)
```

**Property 3 — MEMORY_ENABLED=false guard is universal:**
```typescript
// Feature: phase-6.4-memory-browser, Property 3: MEMORY_ENABLED=false guard applies to all protected routes
fc.property(
  fc.constantFrom(...PROTECTED_ROUTES),
  async (route) => {
    const res = await callRouteWithMemoryDisabled(route);
    return res.status === 503;
  }
)
```

**Property 4 — workspaceId validation is consistent:**
```typescript
// Feature: phase-6.4-memory-browser, Property 4: workspaceId validation is consistent across all routes
fc.property(
  fc.constantFrom(...PROTECTED_ROUTES),
  fc.oneof(
    fc.constant(''),
    fc.constant(null),
    fc.stringOf(fc.constant(' '), { minLength: 1 })
  ),
  async (route, badWorkspaceId) => {
    const res = await callRoute(route, { workspaceId: badWorkspaceId });
    return res.status === 400;
  }
)
```

**Property 5 — XSS escaping in memory card:**
```typescript
// Feature: phase-6.4-memory-browser, Property 5: memory card text rendering escapes HTML metacharacters
fc.property(
  fc.string().filter(s => /[<>"'&]/.test(s)),
  (text) => {
    const html = renderMemoryCard({ ...minimalMemory, text });
    // The raw text must not appear verbatim if it contains HTML metacharacters
    return !html.includes(text);
  }
)
```

**Property 6 — Score badge is exhaustive:**
```typescript
// Feature: phase-6.4-memory-browser, Property 6: quality score badge colour classification is exhaustive
fc.property(
  fc.float({ min: 0, max: 1, noNaN: true }),
  (score) => {
    const cls = scoreClass(score);
    return cls === 'high' || cls === 'medium' || cls === 'low';
  }
)
```

**Property 7 — Graph aria-label reflects entity count:**
```typescript
// Feature: phase-6.4-memory-browser, Property 7: graph aria-label reflects entity count accurately
fc.property(
  fc.array(fc.record({ id: fc.uuid(), name: fc.string(), type: fc.constantFrom('primary', 'secondary') })),
  (entities) => {
    const html = renderMemoryGraph(entities, []);
    return html.includes(`with ${entities.length} entities`);
  }
)
```

**Property 8 — sr-only table completeness:**
```typescript
// Feature: phase-6.4-memory-browser, Property 8: sr-only table contains all entity names and relations
fc.property(
  fc.array(fc.record({ id: fc.uuid(), name: fc.uniqueString(), type: fc.constantFrom('primary', 'secondary') }), { minLength: 3 }),
  fc.array(fc.record({ from: fc.string(), to: fc.string(), label: fc.string() })),
  (entities, relations) => {
    const html = renderMemoryGraph(entities, relations);
    return entities.every(e => html.includes(esc(e.name)));
  }
)
```
