// workspace-cache.ts
// Per-workspace cache management for multi-workspace monitoring.
// Provides independent cache storage for each workspace to optimize scanning.

import { SCAN_CACHE_TTL } from '../constants.ts';
import type { SessionState, Chain, Job } from '../types.ts';

/**
 * Cache entry structure with data and timestamp for TTL validation.
 */
export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * Generic per-workspace cache interface.
 * Maintains separate cache storage keyed by workspace ID.
 */
export interface PerWorkspaceCache<T> {
  /**
   * Get cached data for a workspace.
   * @param workspaceId Workspace identifier
   * @returns Cached data if valid (not expired), null if expired or not found
   */
  get(workspaceId: string): T | null;

  /**
   * Set cached data for a workspace.
   * @param workspaceId Workspace identifier
   * @param data Data to cache
   */
  set(workspaceId: string, data: T): void;

  /**
   * Invalidate cache for a specific workspace.
   * @param workspaceId Workspace identifier
   */
  invalidate(workspaceId: string): void;

  /**
   * Invalidate all workspace caches.
   */
  invalidateAll(): void;
}

/**
 * Implementation of per-workspace cache with TTL support.
 */
class PerWorkspaceCacheImpl<T> implements PerWorkspaceCache<T> {
  private cache: Map<string, CacheEntry<T>>;
  private ttl: number;

  constructor(ttl: number = SCAN_CACHE_TTL) {
    this.cache = new Map();
    this.ttl = ttl;
  }

  get(workspaceId: string): T | null {
    const entry = this.cache.get(workspaceId);
    if (!entry) {
      return null;
    }

    // Check TTL
    const now = Date.now();
    if (now - entry.timestamp >= this.ttl) {
      // Expired - remove from cache and return null
      this.cache.delete(workspaceId);
      return null;
    }

    return entry.data;
  }

  set(workspaceId: string, data: T): void {
    this.cache.set(workspaceId, {
      data,
      timestamp: Date.now(),
    });
  }

  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}

/**
 * Cache manager interface providing caches for all domain types.
 */
export interface CacheManager {
  sessions: PerWorkspaceCache<SessionState[]>;
  chains: PerWorkspaceCache<Chain[]>;
  jobs: PerWorkspaceCache<Job[]>;
  specs: PerWorkspaceCache<Chain[]>;
}

/**
 * Create a new cache manager instance with per-workspace caches for all domain types.
 */
export function createCacheManager(): CacheManager {
  return {
    sessions: new PerWorkspaceCacheImpl<SessionState[]>(),
    chains: new PerWorkspaceCacheImpl<Chain[]>(),
    jobs: new PerWorkspaceCacheImpl<Job[]>(),
    specs: new PerWorkspaceCacheImpl<Chain[]>(),
  };
}

/**
 * Global cache manager instance (singleton for the application).
 */
export const cacheManager = createCacheManager();
