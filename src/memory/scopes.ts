// ---------------------------------------------------------------------------
// Scope helpers — build MemoryScope from domain objects.
// These pure functions map Job and Chain fields to the MemoryScope structure
// expected by IMemoryClient callers.
// ---------------------------------------------------------------------------

import type { Job, Chain } from '../types.ts';
import type { MemoryScope } from './types.ts';

/**
 * Build a MemoryScope from a Job record.
 *
 * Maps:
 * - `workspaceId` ← job.workspaceId
 * - `agentId`     ← job.agent
 * - `runId`       ← job.id
 */
export function scopeFromJob(job: Job): MemoryScope {
  return {
    workspaceId: job.workspaceId,
    agentId: job.agent,
    runId: job.id,
  };
}

/**
 * Build a MemoryScope from a Chain record.
 *
 * Maps:
 * - `workspaceId` ← chain.workspaceId
 * - `chainId`     ← chain.chainId
 */
export function scopeFromChain(chain: Chain): MemoryScope {
  return {
    workspaceId: chain.workspaceId,
    chainId: chain.chainId,
  };
}
