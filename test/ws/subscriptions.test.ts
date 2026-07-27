/**
 * Unit tests for SubscriptionManager (src/ws/subscriptions.ts)
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { SubscriptionManager } from '../../src/ws/subscriptions';

// ---------------------------------------------------------------------------
// Minimal ServerWebSocket mock — only the interface shape is needed
// ---------------------------------------------------------------------------

const mockWs = { send: () => {}, close: () => {} } as unknown as ServerWebSocket<unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(): SubscriptionManager {
  return new SubscriptionManager();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SubscriptionManager', () => {
  let mgr: SubscriptionManager;

  beforeEach(() => {
    mgr = makeManager();
  });

  // -------------------------------------------------------------------------
  // addClient / removeClient
  // -------------------------------------------------------------------------

  it('should leave no subscriptions or client entries after addClient then removeClient', () => {
    mgr.addClient('c1', mockWs);
    mgr.subscribe('c1', { workspaceId: 'ws-a' });
    mgr.removeClient('c1');

    // getInterestedClients must return empty — no leftover entries
    const clients = mgr.getInterestedClients({ workspaceId: 'ws-a' });
    expect(clients).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // subscribe — return shape
  // -------------------------------------------------------------------------

  it('should return a subscription with a valid id and non-empty createdAt ISO string', () => {
    mgr.addClient('c1', mockWs);
    const sub = mgr.subscribe('c1', { workspaceId: 'ws-a' });

    expect(sub.id).toMatch(/^sub_\d+_[a-z0-9]+$/);
    expect(typeof sub.createdAt).toBe('string');
    expect(sub.createdAt.length).toBeGreaterThan(0);
    // Must parse as a valid date
    expect(isNaN(Date.parse(sub.createdAt))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // subscribe — duplicate detection
  // -------------------------------------------------------------------------

  it('should return existing sub with status "already_subscribed" on duplicate and not create a second entry', () => {
    mgr.addClient('c1', mockWs);
    const first = mgr.subscribe('c1', { workspaceId: 'ws-a', chainId: 'chain-1' });

    // Duplicate — same workspaceId + chainId
    const second = mgr.subscribe('c1', { workspaceId: 'ws-a', chainId: 'chain-1' });

    expect(second.status).toBe('already_subscribed');
    expect(second.id).toBe(first.id);

    // Only one subscription should exist — verified via getInterestedClients
    // returning exactly one client (not two)
    const interested = mgr.getInterestedClients({ workspaceId: 'ws-a', chainId: 'chain-1' });
    expect(interested).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // unsubscribe — existing subscription
  // -------------------------------------------------------------------------

  it('should remove a subscription and exclude that client from getInterestedClients afterwards', () => {
    mgr.addClient('c1', mockWs);
    const sub = mgr.subscribe('c1', { workspaceId: 'ws-a' });

    const result = mgr.unsubscribe('c1', sub.id);
    expect(result.success).toBe(true);

    const clients = mgr.getInterestedClients({ workspaceId: 'ws-a' });
    expect(clients).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // unsubscribe — non-existent subscription
  // -------------------------------------------------------------------------

  it('should return { success: true, status: "not_subscribed" } for a non-existent subscriptionId', () => {
    mgr.addClient('c1', mockWs);
    const result = mgr.unsubscribe('c1', 'sub_9999_doesnotexist');

    expect(result.success).toBe(true);
    expect(result.status).toBe('not_subscribed');
  });

  // -------------------------------------------------------------------------
  // getInterestedClients — workspaceId filter
  // -------------------------------------------------------------------------

  it('should return only clients subscribed to the matching workspaceId, not others', () => {
    mgr.addClient('c-ws-a', mockWs);
    mgr.addClient('c-ws-b', mockWs);

    mgr.subscribe('c-ws-a', { workspaceId: 'ws-a' });
    mgr.subscribe('c-ws-b', { workspaceId: 'ws-b' });

    const interested = mgr.getInterestedClients({ workspaceId: 'ws-a' });
    expect(interested).toHaveLength(1);
    expect(interested[0].id).toBe('c-ws-a');
  });

  // -------------------------------------------------------------------------
  // getInterestedClients — chainId filter
  // -------------------------------------------------------------------------

  it('should return only clients subscribed to the matching chainId', () => {
    mgr.addClient('c-chain-x', mockWs);
    mgr.addClient('c-chain-y', mockWs);

    mgr.subscribe('c-chain-x', { workspaceId: 'ws-a', chainId: 'chain-x' });
    mgr.subscribe('c-chain-y', { workspaceId: 'ws-a', chainId: 'chain-y' });

    const interested = mgr.getInterestedClients({ workspaceId: 'ws-a', chainId: 'chain-x' });
    expect(interested).toHaveLength(1);
    expect(interested[0].id).toBe('c-chain-x');
  });

  // -------------------------------------------------------------------------
  // getInterestedClients — AND semantics for workspaceId + chainId
  // -------------------------------------------------------------------------

  it('should apply AND semantics when both workspaceId and chainId are specified', () => {
    mgr.addClient('c-both', mockWs);
    mgr.addClient('c-ws-only', mockWs);
    mgr.addClient('c-chain-only', mockWs);

    // c-both: subscribed to ws-a AND chain-1
    mgr.subscribe('c-both', { workspaceId: 'ws-a', chainId: 'chain-1' });
    // c-ws-only: subscribed to ws-a without chainId filter
    mgr.subscribe('c-ws-only', { workspaceId: 'ws-a' });
    // c-chain-only: subscribed to chain-1 but different workspace
    mgr.subscribe('c-chain-only', { workspaceId: 'ws-b', chainId: 'chain-1' });

    // Only c-both and c-ws-only match (c-ws-only has no chainId restriction so it matches)
    // c-chain-only should NOT match (ws-b != ws-a)
    const interested = mgr.getInterestedClients({ workspaceId: 'ws-a', chainId: 'chain-1' });
    const ids = interested.map((c) => c.id).sort();
    expect(ids).toEqual(['c-both', 'c-ws-only'].sort());
  });

  // -------------------------------------------------------------------------
  // removeClient — cleans up all subscriptions
  // -------------------------------------------------------------------------

  it('should clean up all subscriptions so getInterestedClients returns empty after removeClient', () => {
    mgr.addClient('c1', mockWs);
    mgr.subscribe('c1', { workspaceId: 'ws-a' });
    mgr.subscribe('c1', { workspaceId: 'ws-b' });
    mgr.subscribe('c1', { chainId: 'chain-x' } as { workspaceId?: string; chainId?: string });

    mgr.removeClient('c1');

    expect(mgr.getInterestedClients({ workspaceId: 'ws-a' })).toHaveLength(0);
    expect(mgr.getInterestedClients({ workspaceId: 'ws-b' })).toHaveLength(0);
    expect(mgr.getInterestedClients({ workspaceId: 'ws-a', chainId: 'chain-x' })).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // getInterestedClients — deduplication
  // -------------------------------------------------------------------------

  it('should return each client only once even when it has multiple matching subscriptions', () => {
    mgr.addClient('c1', mockWs);

    // Subscribe to ws-a with no chain filter (matches any chain under ws-a)
    mgr.subscribe('c1', { workspaceId: 'ws-a' });
    // Subscribe to ws-a with chain-1 (also matches the same event)
    mgr.subscribe('c1', { workspaceId: 'ws-a', chainId: 'chain-1' });

    const interested = mgr.getInterestedClients({ workspaceId: 'ws-a', chainId: 'chain-1' });
    expect(interested).toHaveLength(1);
    expect(interested[0].id).toBe('c1');
  });
});
