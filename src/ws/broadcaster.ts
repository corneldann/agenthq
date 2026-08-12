/**
 * WebSocket broadcaster.
 *
 * Fans out server messages to all subscribed clients that match the event,
 * and delivers targeted command-error messages to the originating client.
 *
 * Runtime-agnostic internally — depends only on `SubscriptionManager` and the
 * `ServerMessage` type from `protocol.ts`.
 */

import type { SubscriptionManager } from './subscriptions.js';
import type { ServerMessage } from './protocol.js';

// ---------------------------------------------------------------------------
// WsBroadcaster
// ---------------------------------------------------------------------------

/**
 * Sends `ServerMessage` payloads to WebSocket clients via `SubscriptionManager`.
 *
 * Three delivery modes:
 * - **Fan-out** (`broadcastStatusChange`, `broadcastUserAction`): sends to every
 *   client whose subscription filter matches the event's workspace / chain.
 * - **Targeted** (`broadcastCommandError`): sends to the single originating client
 *   looked up by `clientId`; logs a warning and returns if the client is gone.
 */
export class WsBroadcaster {
  constructor(private readonly subscriptionMgr: SubscriptionManager) {}

  // -------------------------------------------------------------------------
  // Fan-out broadcasts
  // -------------------------------------------------------------------------

  /**
   * Send a `status-change` message to every client subscribed to the given
   * workspace (and optional chain).
   *
   * @param event The status-change event to broadcast
   */
  broadcastStatusChange(event: {
    jobId: string;
    workspaceId: string;
    chainId?: string;
    oldStatus: string;
    newStatus: string;
    success: boolean;
  }): void {
    const clients = this.subscriptionMgr.getInterestedClients({
      workspaceId: event.workspaceId,
      chainId: event.chainId,
    });

    if (clients.length === 0) {
      return;
    }

    const message: ServerMessage = {
      type: 'status-change',
      jobId: event.jobId,
      oldStatus: event.oldStatus,
      newStatus: event.newStatus,
      timestamp: new Date().toISOString(),
      success: event.success,
      workspaceId: event.workspaceId,
    };

    const payload = JSON.stringify(message);

    for (const client of clients) {
      client.ws.send(payload);
    }
  }

  /**
   * Send a `user-action` message to every client subscribed to the given workspace.
   *
   * @param event The user-action event to broadcast
   */
  broadcastUserAction(event: {
    userId: string;
    action: string;
    target: string;
    workspaceId: string;
  }): void {
    const clients = this.subscriptionMgr.getInterestedClients({
      workspaceId: event.workspaceId,
    });

    if (clients.length === 0) {
      return;
    }

    const message: ServerMessage = {
      type: 'user-action',
      userId: event.userId,
      action: event.action,
      target: event.target,
      timestamp: new Date().toISOString(),
    };

    const payload = JSON.stringify(message);

    for (const client of clients) {
      client.ws.send(payload);
    }
  }

  // -------------------------------------------------------------------------
  // Targeted delivery
  // -------------------------------------------------------------------------

  /**
   * Send a `command-error` message to the specific originating client.
   *
   * Looks up the client by `clientId` directly — does not use subscription
   * filtering. If the client is no longer connected, logs a warning and
   * returns silently (the error is safe to drop; the client has disconnected).
   *
   * @param event The command-error event to deliver
   */
  broadcastCommandError(event: {
    clientId: string;
    commandId: string;
    error: string;
  }): void {
    const client = this.subscriptionMgr.getClient(event.clientId);

    if (client === undefined) {
      console.warn(
        `WsBroadcaster.broadcastCommandError: client "${event.clientId}" not found — ` +
          `dropping command-error for commandId "${event.commandId}"`,
      );
      return;
    }

    const message: ServerMessage = {
      type: 'command-error',
      userId: event.clientId,
      commandId: event.commandId,
      error: event.error,
    };

    client.ws.send(JSON.stringify(message));
  }
}
