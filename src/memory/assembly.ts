// ---------------------------------------------------------------------------
// Context assembly — recall memories and format them for agent injection.
// This module orchestrates the pre-job memory recall + token budget pass,
// producing a formatted markdown block that is appended to the agent system
// prompt when MEMORY_AUTO_INJECT=true.
// ---------------------------------------------------------------------------

import type { Job } from '../types.ts';
import type { IMemoryClient, Memory, MemoryScope } from './types.ts';
import { scopeFromJob } from './scopes.ts';
import { MemoryClientError } from './errors.ts';

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/**
 * Configuration for context assembly token budget and recall limits.
 */
export type MemoryAssemblyConfig = {
  /** Candidate recall limit; typically MEMORY_MAX_CONTEXT_MEMORIES * 2. */
  candidateLimit: number;
  /** Maximum tokens the returned block may consume (inclusive). */
  tokenBudget: number;
};

// ---------------------------------------------------------------------------
// Diagnostic types
// ---------------------------------------------------------------------------

/**
 * Fate of a memory during token-budget pass.
 * - 'included': memory was added to the final block
 * - 'dropped': memory exceeded remaining token budget
 */
export type MemoryFate = 'included' | 'dropped';

/**
 * Optional callback for diagnostic mode (inject-test endpoint).
 * Called once per candidate memory with its fate before returning.
 * When undefined (normal agent path), no overhead is incurred.
 */
export type DiagnosticCollector = (memory: Memory, fate: MemoryFate) => void;

// ---------------------------------------------------------------------------
// Token counting
// ---------------------------------------------------------------------------

/**
 * Approximate token count using a conservative 4 characters per token ratio.
 * This avoids a tokenizer dependency while remaining conservative enough
 * to prevent budget overruns.
 */
function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

/**
 * Recall relevant memories for a job and format them within a token budget.
 *
 * Algorithm:
 * 1. Build query string: `"${job.name} ${job.type}"`
 * 2. Build scope: `scopeFromJob(job)`
 * 3. Call `client.recall(query, scope, config.candidateLimit)`
 * 4. Deduct heading tokens from budget before iterating candidates
 * 5. Iterate memories in returned order (descending relevance from Hindsight):
 *    - Compute line tokens: `countTokens("- " + memory.text + "\n")`
 *    - If running total + line tokens ≤ remaining budget → include
 *    - Otherwise → drop (count as dropped)
 * 6. If zero lines included → return ""
 * 7. If dropped > 0 → log at DEBUG
 * 8. Return formatted block with no trailing newline on final bullet
 *
 * @param job - Job record to build query and scope from
 * @param client - Memory client to call recall on
 * @param config - Token budget and recall limit configuration
 * @param collector - Optional diagnostic callback (no overhead when undefined)
 * @returns Formatted memory block or empty string
 */
export async function assembleContext(
  job: Job,
  client: IMemoryClient,
  config: MemoryAssemblyConfig,
  collector?: DiagnosticCollector,
): Promise<string> {
  // Build query and scope
  const query = `${job.name} ${job.type}`;
  const scope: MemoryScope = scopeFromJob(job);

  // Recall candidates
  const candidates = await client.recall(query, scope, config.candidateLimit);

  // Empty result if no candidates
  if (candidates.length === 0) {
    return '';
  }

  // Deduct heading tokens from budget
  const heading = '## Relevant Past Context\n';
  const headingTokens = countTokens(heading);
  let remainingBudget = config.tokenBudget - headingTokens;

  // Token-budget pass
  const lines: string[] = [];
  let dropped = 0;

  for (const memory of candidates) {
    const line = `- ${memory.text}\n`;
    const lineTokens = countTokens(line);

    if (remainingBudget >= lineTokens) {
      lines.push(line);
      remainingBudget -= lineTokens;
      if (collector !== undefined) {
        collector(memory, 'included');
      }
    } else {
      dropped += 1;
      if (collector !== undefined) {
        collector(memory, 'dropped');
      }
    }
  }

  // Empty result if no lines fit budget
  if (lines.length === 0) {
    return '';
  }

  // Log dropped count at DEBUG
  if (dropped > 0) {
    console.debug(`assembleContext: dropped ${dropped} memories over token budget`);
  }

  // Format and return with no trailing newline
  const lastLine = lines[lines.length - 1];
  if (lastLine.endsWith('\n')) {
    lines[lines.length - 1] = lastLine.slice(0, -1);
  }

  return heading + lines.join('');
}

// ---------------------------------------------------------------------------
// Read-only client wrapper
// ---------------------------------------------------------------------------

/**
 * Read-only wrapper for IMemoryClient that forwards recall and reflect,
 * but rejects retain and delete with MemoryClientError.
 * Used by the inject-test diagnostic endpoint to prevent storage side-effects.
 */
export class ReadOnlyMemoryClient implements IMemoryClient {
  readonly #inner: IMemoryClient;

  constructor(inner: IMemoryClient) {
    this.#inner = inner;
  }

  recall(query: string, scope: MemoryScope, limit: number): Promise<Memory[]> {
    return this.#inner.recall(query, scope, limit);
  }

  list(scope: MemoryScope, pageSize: number, cursor: string | null): Promise<{
    memories: Memory[];
    nextCursor: string | null;
    total: number;
  }> {
    return this.#inner.list(scope, pageSize, cursor);
  }

  get(id: string): Promise<Memory | null> {
    return this.#inner.get(id);
  }

  reflect(topic: string, scope: MemoryScope): Promise<string | null> {
    return this.#inner.reflect(topic, scope);
  }

  retain(_text: string, _scope: MemoryScope): Promise<string> {
    return Promise.reject(
      new MemoryClientError(
        'ReadOnlyMemoryClient: retain is not permitted in diagnostic mode',
        403,
        JSON.stringify({ method: 'retain' }),
      ),
    );
  }

  delete(_id: string): Promise<void> {
    return Promise.reject(
      new MemoryClientError(
        'ReadOnlyMemoryClient: delete is not permitted in diagnostic mode',
        403,
        JSON.stringify({ method: 'delete' }),
      ),
    );
  }
}
