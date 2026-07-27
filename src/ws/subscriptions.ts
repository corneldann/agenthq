/**
 * SubscriptionManager — per-client WebSocket subscription tracking.
 *
 * Manages a two-map structure:
 *   clients       Map<clientId, WsClient>
 *   subscriptions Map<subscriptionId, Subscription>
 *
 * All mutations keep both maps in sync so that removeClient never leaks
 * orphan subscription entries.
 */

import type { ServerWebSocket } from 'bun';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface Subscription {
  id: string;
  clientId: string;
  workspaceId?: string;
  chainId?: string;
  createdAt: string; // ISO 8601
}

export interface WsClient {
  id: string;
  subscriptions: Set<string>; // subscription IDs
  lastActivity: number;       // Date.now()
  ws: ServerWebSocket<unknown>;
}

// ---------------------------------------------------------------------------
// SubscriptionManager
// ---------------------------------------------------------------------------

export class SubscriptionManager {
  private clients = new Map<string, WsClient>();
  private subscriptions = new Map<string, Subscription>();

  // -------------------------------------------------------------------------
  // Client lifecycle
  // -------------------------------------------------------------------------

  /**
   * Register a new WebSocket client. Initialises an empty subscription set
   * and records lastActivity as Date.now().
   */
  addClient(clientId: string, ws: ServerWebSocket<unknown>): void {
    this.clients.set(clientId, {
      id: clientId,
      subscriptions: new Set(),
      lastActivity: Date.now(),
      ws,
    });
  }

  /**
   * Remove a client and ALL of its subscriptions from both maps.
   * Safe to call when the client is not registered (no-op).
   */
  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client === undefined) {
      return;
    }

    for (const subId of client.subscriptions) {
      this.subscriptions.delete(subId);
    }

    this.clients.delete(clientId);
  }

  // -------------------------------------------------------------------------
  // Subscription management
  // -------------------------------------------------------------------------

  /**
   * Subscribe the given client to a workspace/chain filter.
   *
   * If an identical subscription (same workspaceId + chainId) already exists
   * for this client, returns the existing subscription with an extra
   * `status: 'already_subscribed'` field — no duplicate is created.
   *
   * Throws if the client is not registered.
   */
  subscribe(
    clientId: string,
    filter: { workspaceId?: string; chainId?: string },
  ): Subscription & { status?: 'already_subscribed' } {
    const client = this.clients.get(clientId);
    if (client === undefined) {
      throw new Error(`Client ${clientId} not found`);
    }

    // Duplicate detection — same workspaceId + chainId for this client
    for (const subId of client.subscriptions) {
      const existing = this.subscriptions.get(subId);
      if (
        existing !== undefined &&
        existing.workspaceId === filter.workspaceId &&
        existing.chainId === filter.chainId
      ) {
        return { ...existing, status: 'already_subscribed' };
      }
    }

    const subId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const subscription: Subscription = {
      id: subId,
      clientId,
      workspaceId: filter.workspaceId,
      chainId: filter.chainId,
      createdAt: new Date().toISOString(),
    };

    this.subscriptions.set(subId, subscription);
    client.subscriptions.add(subId);
    client.lastActivity = Date.now();

    return subscription;
  }

  /**
   * Remove a specific subscription.
   *
   * If the subscription does not exist, returns
   * `{ success: true, status: 'not_subscribed' }` (idempotent).
   * Otherwise removes from both maps and returns `{ success: true }`.
   */
  unsubscribe(
    clientId: string,
    subscriptionId: string,
  ): { success: true; status?: 'not_subscribed' } {
    const sub = this.subscriptions.get(subscriptionId);
    if (sub === undefined) {
      return { success: true, status: 'not_subscribed' };
    }

    this.subscriptions.delete(subscriptionId);

    const client = this.clients.get(clientId);
    if (client !== undefined) {
      client.subscriptions.delete(subscriptionId);
      client.lastActivity = Date.now();
    }

    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Broadcast helpers
  // -------------------------------------------------------------------------

  /**
   * Return the unique set of clients interested in the given event.
   *
   * Matching rules (applied per subscription):
   *   - If sub.workspaceId is set, it MUST equal event.workspaceId.
   *   - If sub.chainId is set, it MUST equal event.chainId.
   *
   * Clients with multiple matching subscriptions appear only once (deduped by
   * clientId).
   */
  getInterestedClients(event: { workspaceId: string; chainId?: string }): WsClient[] {
    const seen = new Map<string, WsClient>();

    for (const sub of this.subscriptions.values()) {
      if (sub.workspaceId !== undefined && sub.workspaceId !== event.workspaceId) {
        continue;
      }
      if (sub.chainId !== undefined && sub.chainId !== event.chainId) {
        continue;
      }

      const client = this.clients.get(sub.clientId);
      if (client !== undefined && !seen.has(sub.clientId)) {
        seen.set(sub.clientId, client);
      }
    }

    return [...seen.values()];
  }
}
