/**
 * Tests for src/ws/broadcaster.ts
 *
 * Covers:
 *  - broadcastStatusChange: fan-out to interested clients, JSON payload shape
 *  - broadcastUserAction: fan-out to interested clients, JSON payload shape
 *  - broadcastCommandError: targeted delivery, missing-client warning + no-op
 *
 * Validates: Requirements 4.8, 5.1, 5.2, 5.3
 */

import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { SubscriptionManager } from '../../src/ws/subscriptions';
import { WsBroadcaster } from '../../src/ws/broadcaster';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal ServerWebSocket mock that captures `send` calls. */
function makeMockWs(): { ws: ServerWebSocket<unknown>; sends: string[] } {
  const sends: string[] = [];
  const ws = {
    send: (payload: string) => {
      sends.push(payload);
    },
    close: () => {},
  } as unknown as ServerWebSocket<unknown>;
  return { ws, sends };
}

/**
 * Build a SubscriptionManager with a pre-registered client, and the
 * accompanying WsBroadcaster.
 */
function makeSetup(clientId = 'client-1'): {
  mgr: SubscriptionManager;
  broadcaster: WsBroadcaster;
  clientId: string;
  sends: string[];
} {
  const { ws, sends } = makeMockWs();
  const mgr = new SubscriptionManager();
  mgr.addClient(clientId, ws);
  const broadcaster = new WsBroadcaster(mgr);
  return { mgr, broadcaster, clientId, sends };
}

// ---------------------------------------------------------------------------
// broadcastStatusChange
// ---------------------------------------------------------------------------

describe('WsBroadcaster — broadcastStatusChange', () => {
  it('should send a status-change message to a subscribed client', () => {
    const { mgr, broadcaster, clientId, sends } = makeSetup();
    mgr.subscribe(clientId, { workspaceId: 'ws-1' });

    broadcaster.broadcastStatusChange({
      jobId: 'job-42',
      workspaceId: 'ws-1',
      oldStatus: 'running',
      newStatus: 'done',
      success: true,
    });

    expect(sends).toHaveLength(1);
    const msg = JSON.parse(sends[0]);
    expect(msg.type).toBe('status-change');
    expect(msg.jobId).toBe('job-42');
    expect(msg.oldStatus).toBe('running');
    expect(msg.newStatus).toBe('done');
    expect(msg.success).toBe(true);
    expect(msg.workspaceId).toBe('ws-1');
    expect(typeof msg.timestamp).toBe('string');
    expect(msg.timestamp).toContain('T');
  });

  it('should include the chainId filter in workspace+chain subscription matching', () => {
    const { mgr, broadcaster, clientId, sends } = makeSetup();
    mgr.subscribe(clientId, { workspaceId: 'ws-1', chainId: 'chain-99' });

    broadcaster.broadcastStatusChange({
      jobId: 'job-1',
      workspaceId: 'ws-1',
      chainId: 'chain-99',
      oldStatus: 'running',
      newStatus: 'error',
      success: false,
    });

    expect(sends).toHaveLength(1);
    const msg = JSON.parse(sends[0]);
    expect(msg.type).toBe('status-change');
    expect(msg.jobId).toBe('job-1');
  });

  it('should not send to a client subscribed to a different workspace', () => {
    const { mgr, broadcaster, clientId, sends } = makeSetup();
    mgr.subscribe(clientId, { workspaceId: 'ws-other' });

    broadcaster.broadcastStatusChange({
      jobId: 'job-1',
      workspaceId: 'ws-1',
      oldStatus: 'running',
      newStatus: 'done',
      success: true,
    });

    expect(sends).toHaveLength(0);
  });

  it('should send to multiple subscribed clients', () => {
    const mgr = new SubscriptionManager();
    const { ws: wsA, sends: sendsA } = makeMockWs();
    const { ws: wsB, sends: sendsB } = makeMockWs();

    mgr.addClient('client-a', wsA);
    mgr.addClient('client-b', wsB);

    mgr.subscribe('client-a', { workspaceId: 'ws-1' });
    mgr.subscribe('client-b', { workspaceId: 'ws-1' });

    const broadcaster = new WsBroadcaster(mgr);

    broadcaster.broadcastStatusChange({
      jobId: 'job-x',
      workspaceId: 'ws-1',
      oldStatus: 'running',
      newStatus: 'done',
      success: true,
    });

    expect(sendsA).toHaveLength(1);
    expect(sendsB).toHaveLength(1);
  });

  it('should not send when no clients are subscribed', () => {
    const { broadcaster, sends } = makeSetup();
    // No subscribe call — no interested clients.

    broadcaster.broadcastStatusChange({
      jobId: 'job-1',
      workspaceId: 'ws-1',
      oldStatus: 'running',
      newStatus: 'done',
      success: true,
    });

    expect(sends).toHaveLength(0);
  });

  it('should send the same pre-serialized payload to all clients (not redundant stringify)', () => {
    const mgr = new SubscriptionManager();
    const receivedA: string[] = [];
    const receivedB: string[] = [];

    mgr.addClient('a', { send: (p: string) => receivedA.push(p), close: () => {} } as unknown as ServerWebSocket<unknown>);
    mgr.addClient('b', { send: (p: string) => receivedB.push(p), close: () => {} } as unknown as ServerWebSocket<unknown>);

    mgr.subscribe('a', { workspaceId: 'ws-1' });
    mgr.subscribe('b', { workspaceId: 'ws-1' });

    const broadcaster = new WsBroadcaster(mgr);
    broadcaster.broadcastStatusChange({
      jobId: 'j',
      workspaceId: 'ws-1',
      oldStatus: 'running',
      newStatus: 'done',
      success: true,
    });

    // Both clients should receive identical payloads.
    expect(receivedA[0]).toBe(receivedB[0]);
  });
});

// ---------------------------------------------------------------------------
// broadcastUserAction
// ---------------------------------------------------------------------------

describe('WsBroadcaster — broadcastUserAction', () => {
  it('should send a user-action message to a subscribed client', () => {
    const { mgr, broadcaster, clientId, sends } = makeSetup();
    mgr.subscribe(clientId, { workspaceId: 'ws-1' });

    broadcaster.broadcastUserAction({
      userId: 'user-7',
      action: 'cancel',
      target: 'job-42',
      workspaceId: 'ws-1',
    });

    expect(sends).toHaveLength(1);
    const msg = JSON.parse(sends[0]);
    expect(msg.type).toBe('user-action');
    expect(msg.userId).toBe('user-7');
    expect(msg.action).toBe('cancel');
    expect(msg.target).toBe('job-42');
    expect(typeof msg.timestamp).toBe('string');
    expect(msg.timestamp).toContain('T');
  });

  it('should not send to a client in a different workspace', () => {
    const { mgr, broadcaster, clientId, sends } = makeSetup();
    mgr.subscribe(clientId, { workspaceId: 'ws-other' });

    broadcaster.broadcastUserAction({
      userId: 'user-1',
      action: 'pause',
      target: 'session-1',
      workspaceId: 'ws-1',
    });

    expect(sends).toHaveLength(0);
  });

  it('should not send when no clients are subscribed', () => {
    const { broadcaster, sends } = makeSetup();

    broadcaster.broadcastUserAction({
      userId: 'user-1',
      action: 'resume',
      target: 'session-1',
      workspaceId: 'ws-1',
    });

    expect(sends).toHaveLength(0);
  });

  it('should send to all workspace-matching clients', () => {
    const mgr = new SubscriptionManager();
    const { ws: wsA, sends: sendsA } = makeMockWs();
    const { ws: wsB, sends: sendsB } = makeMockWs();

    mgr.addClient('client-a', wsA);
    mgr.addClient('client-b', wsB);

    mgr.subscribe('client-a', { workspaceId: 'ws-shared' });
    mgr.subscribe('client-b', { workspaceId: 'ws-shared' });

    const broadcaster = new WsBroadcaster(mgr);
    broadcaster.broadcastUserAction({
      userId: 'user-1',
      action: 'cancel',
      target: 'job-1',
      workspaceId: 'ws-shared',
    });

    expect(sendsA).toHaveLength(1);
    expect(sendsB).toHaveLength(1);
    expect(JSON.parse(sendsA[0]).type).toBe('user-action');
    expect(JSON.parse(sendsB[0]).type).toBe('user-action');
  });
});

// ---------------------------------------------------------------------------
// broadcastCommandError
// ---------------------------------------------------------------------------

describe('WsBroadcaster — broadcastCommandError', () => {
  it('should send a command-error message to the originating client', () => {
    const { mgr, broadcaster, clientId, sends } = makeSetup();

    broadcaster.broadcastCommandError({
      clientId,
      commandId: 'cmd_123_abc',
      error: 'workspace mismatch',
    });

    expect(sends).toHaveLength(1);
    const msg = JSON.parse(sends[0]);
    expect(msg.type).toBe('command-error');
    expect(msg.userId).toBe(clientId);
    expect(msg.commandId).toBe('cmd_123_abc');
    expect(msg.error).toBe('workspace mismatch');
  });

  it('should not require a subscription — targets client directly by id', () => {
    const { mgr, broadcaster, clientId, sends } = makeSetup();
    // Deliberately skip subscribe() — client is registered but not subscribed.

    broadcaster.broadcastCommandError({
      clientId,
      commandId: 'cmd_999_xyz',
      error: 'not found',
    });

    expect(sends).toHaveLength(1);
    expect(JSON.parse(sends[0]).type).toBe('command-error');
  });

  it('should log a warning and not throw when the client is not found', () => {
    const { broadcaster } = makeSetup();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => {
      broadcaster.broadcastCommandError({
        clientId: 'ghost-client',
        commandId: 'cmd_1_abc',
        error: 'some error',
      });
    }).not.toThrow();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg: string = warnSpy.mock.calls[0][0] as string;
    expect(warnArg).toContain('ghost-client');
    expect(warnArg).toContain('cmd_1_abc');

    warnSpy.mockRestore();
  });

  it('should not send to any other client when the target client is found', () => {
    const mgr = new SubscriptionManager();
    const { ws: wsTarget, sends: sendsTarget } = makeMockWs();
    const { ws: wsOther, sends: sendsOther } = makeMockWs();

    mgr.addClient('target', wsTarget);
    mgr.addClient('other', wsOther);

    // Both subscribed to same workspace — broadcast wouldn't differentiate them.
    mgr.subscribe('target', { workspaceId: 'ws-1' });
    mgr.subscribe('other', { workspaceId: 'ws-1' });

    const broadcaster = new WsBroadcaster(mgr);

    broadcaster.broadcastCommandError({
      clientId: 'target',
      commandId: 'cmd_1_abc',
      error: 'oops',
    });

    expect(sendsTarget).toHaveLength(1);
    expect(sendsOther).toHaveLength(0);
  });

  it('should not send anything when the client disconnected before error delivery', () => {
    const { mgr, broadcaster, clientId, sends } = makeSetup();
    mgr.removeClient(clientId);

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    broadcaster.broadcastCommandError({
      clientId,
      commandId: 'cmd_2_abc',
      error: 'late error',
    });

    expect(sends).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});
