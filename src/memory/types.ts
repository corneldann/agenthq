// ---------------------------------------------------------------------------
// Memory domain types — single authoritative source for Phase 6.1.
// This file contains ONLY export interface / export type / export const
// declarations. No logic, no functions, no runtime imports.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export type MemoryScope = {
  workspaceId: string;       // required — identifies the workspace
  userId?: string;           // optional — identifies the user
  agentId?: string;          // optional — identifies the agent
  runId?: string;            // optional — identifies a specific run/job
  chainId?: string;          // optional — identifies a session chain
};

// ---------------------------------------------------------------------------
// Memory record
// ---------------------------------------------------------------------------

export type Memory = {
  id: string;
  text: string;
  scope: MemoryScope;
  qualityScore: number;
  createdAt: string;         // ISO 8601
  lastRetrievedAt: string;   // ISO 8601
  retrievalCount: number;
  tier: 'hot' | 'warm' | 'cold';
  embeddingStatus: 'pending' | 'ready' | 'failed';
};

// ---------------------------------------------------------------------------
// IMemoryClient — port interface; all callers depend only on this
// ---------------------------------------------------------------------------

export interface IMemoryClient {
  /** Store a memory and return its assigned ID. */
  retain(text: string, scope: MemoryScope): Promise<string>;

  /** Retrieve memories ordered by descending relevance. */
  recall(query: string, scope: MemoryScope, limit: number): Promise<Memory[]>;

  /** List memories with cursor-based pagination, sorted by createdAt DESC. */
  list(scope: MemoryScope, pageSize: number, cursor: string | null): Promise<{
    memories: Memory[];
    nextCursor: string | null;
    total: number;
  }>;

  /** Retrieve a single memory by ID, or return null if not found. */
  get(id: string): Promise<Memory | null>;

  /** Synthesise a reflection on a topic, or return null if none available. */
  reflect(topic: string, scope: MemoryScope): Promise<string | null>;

  /** Remove a memory by ID. */
  delete(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// CircuitState — as const object (not a TypeScript enum; project convention)
// ---------------------------------------------------------------------------

export const CircuitState = {
  closed: 'closed',
  open: 'open',
  half_open: 'half_open',
} as const;

export type CircuitState = typeof CircuitState[keyof typeof CircuitState];

// ---------------------------------------------------------------------------
// CircuitBreakerMetrics
// ---------------------------------------------------------------------------

export type CircuitBreakerMetrics = {
  state: CircuitState | 'disabled';
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureAt: string | null;   // ISO 8601; null when no failure recorded
  lastSuccessAt: string | null;   // ISO 8601; null when no success recorded
  openedAt: string | null;        // ISO 8601; null when circuit is not open
};

// ---------------------------------------------------------------------------
// RetryQueueEntry
// ---------------------------------------------------------------------------

export type RetryQueueEntry = {
  id: string;          // UUID
  text: string;        // text passed to retain()
  scope: MemoryScope;
  queuedAt: string;    // ISO 8601
  attempts: number;    // number of failed drain attempts so far
};
