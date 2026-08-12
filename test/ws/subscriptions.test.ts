/**
 * Tests for src/ws/subscriptions.ts
 *
 * Covers:
 *  - Client lifecycle: addClient / removeClient
 *  - Subscription management: subscribe / unsubscribe / duplicate detection
 *  - Broadcast helpers: getInterestedClients (workspace filter, chain filter, AND semantics, dedup)
 *  - Direct lookup: getClient
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 11.2
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import {
  SubscriptionManager,
  type Subscription,
  type DuplicateSubscriptionResult,
} from '../../src/ws/subscriptions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal ServerWebSocket mock — satisfies the type constraint without real socket I/O. */
function makeMockWs(): ServerWebSocket<unknown> {
  return { send: () => {}, close: () => {} } as unknown as ServerWebSocket<unknown>;
}

/** Returns a new SubscriptionManager and a pre-registered client. */
function makeManagerWithClient(clientId = 'client-1'): {
  mgr: SubscriptionManager;
  clientId: string;
} {
  const mgr = new SubscriptionManager();
  mgr.addClient(clientId, makeMockWs());
  return { mgr, clientId };
}

// ---------------------------------------------------------------------------
// Client lifecycle
// ---------------------------------------------------------------------------

describe('SubscriptionManager — client lifecycle', () => {
  it('should add a client and retrieve it via getClient', () => {
    const { mgr, clientId } = makeManagerWithClient();
    const client = mgr.getClient(clientId);
    expect(client).toBeDefined();
    expect(client?.id).toBe(clientId);
  });

  it('should return undefined for an unknown clientId via getClient', () => {
    const mgr = new SubscriptionManager();
    expect(mgr.getClient('no-such-client')).toBeUndefined();
  });

  it('should remove the client entry after removeClient', () => {
    const { mgr, clientId } = makeManagerWithClient();
    mgr.removeClient(clientId);
    expect(mgr.getClient(clientId)).toBeUndefined();
  });

  it('should remove all client subscriptions after removeClient', () => {
    const { mgr, clientId } = makeManagerWithClient();
    mgr.subscribe(clientId, { workspaceId: 'ws-1' });
    mgr.subscribe(clientId, { workspaceId: 'ws-2' });

    mgr.removeClient(clientId);

    // No subscriptions should remain — getInterestedClients must return empty.
    const interested = mgr.getInterestedClients({ workspaceId: 'ws-1' });
    expect(interested).toHaveLength(0);
  });

  it('should be a no-op when removing a clientId that was never added', () => {
    const mgr = new SubscriptionManager();
    // Must not throw.
    expect(() => mgr.removeClient('ghost-client')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// subscribe
// ---------------------------------------------------------------------------

describe('SubscriptionManager — subscribe', () => {
  it('should return a subscription with a valid id matching /^sub_\\d+_[a-z0-9]+$/', () => {
    const { mgr, clientId } = makeManagerWithClient();
    const sub = mgr.subscribe(clientId, { workspaceId: 'ws-1' });
    expect(sub.id).toMatch(/^sub_\d+_[a-z0-9]+$/);
  });

  it('should return a subscription with a non-empty ISO 8601 createdAt timestamp', () => {
    const { mgr, clientId } = makeManagerWithClient();
    const sub = mgr.subscribe(clientId, { workspaceId: 'ws-1' });
    expect(sub.createdAt).toBeTypeOf('string');
    expect(sub.createdAt.length).toBeGreaterThan(0);
    // ISO 8601 datetime strings contain a 'T' separator.
    expect(sub.createdAt).toContain('T');
  });

  it('should return a subscription carrying the clientId and filter fields', () => {
    const { mgr, clientId } = makeManagerWithClient();
    const sub = mgr.subscribe(clientId, { workspaceId: 'ws-abc', chainId: 'chain-xyz' });
    expect(sub.clientId).toBe(clientId);
    expect(sub.workspaceId).toBe('ws-abc');
    expect(sub.chainId).toBe('chain-xyz');
  });

  it('should return an existing subscription with status "already_subscribed" on duplicate filter', () => {
    const { mgr, clientId } = makeManagerWithClient();
    const first = mgr.subscribe(clientId, { workspaceId: 'ws-1', chainId: 'chain-1' });
    const second = mgr.subscribe(clientId, { workspaceId: 'ws-1', chainId: 'chain-1' });

    // The second call must carry the already_subscribed status.
    expect((second as DuplicateSubscriptionResult).status).toBe('already_subscribed');
    // The id must refer to the original subscription, not a new one.
    expect(second.id).toBe(first.id);
  });

  it('should not create a second subscription entry for a duplicate filter', () => {
    const { mgr, clientId } = makeManagerWithClient();
    mgr.subscribe(clientId, { workspaceId: 'ws-1', chainId: 'chain-1' });
    mgr.subscribe(clientId, { workspaceId: 'ws-1', chainId: 'chain-1' });

    // Only one interested client, not two counts of the same client.
    const clients = mgr.getInterestedClients({ workspaceId: 'ws-1', chainId: 'chain-1' });
    expect(clients).toHaveLength(1);
  });

  it('should allow two subscriptions with different filters for the same client', () => {
    const { mgr, clientId } = makeManagerWithClient();
    const sub1 = mgr.subscribe(clientId, { workspaceId: 'ws-1' });
    const sub2 = mgr.subscribe(clientId, { workspaceId: 'ws-2' });

    expect(sub1.id).not.toBe(sub2.id);
    // Neither call should produce already_subscribed.
    expect((sub1 as DuplicateSubscriptionResult).status).toBeUndefined();
    expect((sub2 as DuplicateSubscriptionResult).status).toBeUndefined();
  });

  it('should throw when subscribing a clientId that has not been registered', () => {
    const mgr = new SubscriptionManager();
    expect(() => mgr.subscribe('ghost-client', { workspaceId: 'ws-1' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// unsubscribe
// ---------------------------------------------------------------------------

describe('SubscriptionManager — unsubscribe', () => {
  it('should return { success: true } when removing an existing subscription', () => {
    const { mgr, clientId } = makeManagerWithClient();
    const sub = mgr.subscribe(clientId, { workspaceId: 'ws-1' }) as Subscription;
    const result = mgr.unsubscribe(clientId, sub.id);
    expect(result.success).toBe(true);
    expect((result as { status?: string }).status).toBeUndefined();
  });

  it('should exclude the client from getInterestedClients after unsubscribe', () => {
    const { mgr, clientId } = makeManagerWithClient();
    const sub = mgr.subscribe(clientId, { workspaceId: 'ws-1' }) as Subscription;

    mgr.unsubscribe(clientId, sub.id);

    const interested = mgr.getInterestedClients({ workspaceId: 'ws-1' });
    expect(interested).toHaveLength(0);
  });

  it('should return { success: true, status: "not_subscribed" } for a non-existent subscriptionId', () => {
    const { mgr, clientId } = makeManagerWithClient();
    const result = mgr.unsubscribe(clientId, 'sub_999_doesnotexist');
    expect(result.success).toBe(true);
    expect((result as { status?: string }).status).toBe('not_subscribed');
  });

  it('should not throw when unsubscribing a non-existent subscriptionId', () => {
    const { mgr, clientId } = makeManagerWithClient();
    expect(() => mgr.unsubscribe(clientId, 'sub_0_ghost')).not.toThrow();
  });

  it('should only remove the targeted subscription, leaving others intact', () => {
    const { mgr, clientId } = makeManagerWithClient();
    const sub1 = mgr.subscribe(clientId, { workspaceId: 'ws-1' }) as Subscription;
    mgr.subscribe(clientId, { workspaceId: 'ws-2' });

    mgr.unsubscribe(clientId, sub1.id);

    // ws-2 subscription remains.
    const stillInterested = mgr.getInterestedClients({ workspaceId: 'ws-2' });
    expect(stillInterested).toHaveLength(1);

    // ws-1 subscription is gone.
    const gone = mgr.getInterestedClients({ workspaceId: 'ws-1' });
    expect(gone).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getInterestedClients — filtering
// ---------------------------------------------------------------------------

describe('SubscriptionManager — getInterestedClients filtering', () => {
  it('should return only clients subscribed to the matching workspace', () => {
    const mgr = new SubscriptionManager();
    mgr.addClient('client-a', makeMockWs());
    mgr.addClient('client-b', makeMockWs());

    mgr.subscribe('client-a', { workspaceId: 'ws-1' });
    mgr.subscribe('client-b', { workspaceId: 'ws-2' });

    const interested = mgr.getInterestedClients({ workspaceId: 'ws-1' });
    expect(interested).toHaveLength(1);
    expect(interested[0].id).toBe('client-a');
  });

  it('should not return clients subscribed to a different workspace', () => {
    const mgr = new SubscriptionManager();
    mgr.addClient('client-a', makeMockWs());
    mgr.subscribe('client-a', { workspaceId: 'ws-other' });

    const interested = mgr.getInterestedClients({ workspaceId: 'ws-1' });
    expect(interested).toHaveLength(0);
  });

  it('should return only clients subscribed to the matching chainId', () => {
    const mgr = new SubscriptionManager();
    mgr.addClient('client-a', makeMockWs());
    mgr.addClient('client-b', makeMockWs());

    // Both subscribe to ws-1, but different chains.
    mgr.subscribe('client-a', { workspaceId: 'ws-1', chainId: 'chain-1' });
    mgr.subscribe('client-b', { workspaceId: 'ws-1', chainId: 'chain-2' });

    const interested = mgr.getInterestedClients({ workspaceId: 'ws-1', chainId: 'chain-1' });
    expect(interested).toHaveLength(1);
    expect(interested[0].id).toBe('client-a');
  });

  it('should apply workspace AND chain filter together', () => {
    const mgr = new SubscriptionManager();
    mgr.addClient('client-a', makeMockWs());
    mgr.addClient('client-b', makeMockWs());
    mgr.addClient('client-c', makeMockWs());

    // client-a: matches both workspace and chain.
    mgr.subscribe('client-a', { workspaceId: 'ws-1', chainId: 'chain-1' });
    // client-b: matches workspace only.
    mgr.subscribe('client-b', { workspaceId: 'ws-1', chainId: 'chain-2' });
    // client-c: matches neither.
    mgr.subscribe('client-c', { workspaceId: 'ws-2', chainId: 'chain-1' });

    const interested = mgr.getInterestedClients({ workspaceId: 'ws-1', chainId: 'chain-1' });
    expect(interested).toHaveLength(1);
    expect(interested[0].id).toBe('client-a');
  });

  it('should include wildcard subscribers (no workspace or chain filter) for any event', () => {
    const mgr = new SubscriptionManager();
    mgr.addClient('client-wildcard', makeMockWs());
    // Subscribe with no filters — matches everything.
    mgr.subscribe('client-wildcard', {});

    const interested = mgr.getInterestedClients({ workspaceId: 'ws-anything', chainId: 'chain-anything' });
    expect(interested).toHaveLength(1);
    expect(interested[0].id).toBe('client-wildcard');
  });

  it('should return an empty array when no clients are subscribed', () => {
    const mgr = new SubscriptionManager();
    const interested = mgr.getInterestedClients({ workspaceId: 'ws-1' });
    expect(interested).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getInterestedClients — deduplication
// ---------------------------------------------------------------------------

describe('SubscriptionManager — getInterestedClients deduplication', () => {
  it('should return each client at most once even when multiple subscriptions match', () => {
    const { mgr, clientId } = makeManagerWithClient();

    // Two different subscriptions on the same workspace, both match the event.
    mgr.subscribe(clientId, { workspaceId: 'ws-1' });
    mgr.subscribe(clientId, { workspaceId: 'ws-1', chainId: 'chain-1' });

    const interested = mgr.getInterestedClients({ workspaceId: 'ws-1', chainId: 'chain-1' });
    expect(interested).toHaveLength(1);
    expect(interested[0].id).toBe(clientId);
  });
});

// ---------------------------------------------------------------------------
// removeClient — full cleanup
// ---------------------------------------------------------------------------

describe('SubscriptionManager — removeClient cleanup', () => {
  it('should leave getInterestedClients returning an empty array after removeClient', () => {
    const { mgr, clientId } = makeManagerWithClient();
    mgr.subscribe(clientId, { workspaceId: 'ws-1' });
    mgr.subscribe(clientId, { workspaceId: 'ws-2' });

    mgr.removeClient(clientId);

    expect(mgr.getInterestedClients({ workspaceId: 'ws-1' })).toHaveLength(0);
    expect(mgr.getInterestedClients({ workspaceId: 'ws-2' })).toHaveLength(0);
  });

  it('should not affect other clients when one client is removed', () => {
    const mgr = new SubscriptionManager();
    mgr.addClient('client-a', makeMockWs());
    mgr.addClient('client-b', makeMockWs());

    mgr.subscribe('client-a', { workspaceId: 'ws-1' });
    mgr.subscribe('client-b', { workspaceId: 'ws-1' });

    mgr.removeClient('client-a');

    const interested = mgr.getInterestedClients({ workspaceId: 'ws-1' });
    expect(interested).toHaveLength(1);
    expect(interested[0].id).toBe('client-b');
  });
});

// ---------------------------------------------------------------------------
// getClient
// ---------------------------------------------------------------------------

describe('SubscriptionManager — getClient', () => {
  it('should return the client when it is present', () => {
    const { mgr, clientId } = makeManagerWithClient();
    const client = mgr.getClient(clientId);
    expect(client).toBeDefined();
    expect(client?.id).toBe(clientId);
    expect(client?.subscriptions).toBeInstanceOf(Set);
  });

  it('should return undefined when the client is absent', () => {
    const mgr = new SubscriptionManager();
    expect(mgr.getClient('nobody')).toBeUndefined();
  });

  it('should return undefined after the client has been removed', () => {
    const { mgr, clientId } = makeManagerWithClient();
    mgr.removeClient(clientId);
    expect(mgr.getClient(clientId)).toBeUndefined();
  });
});
