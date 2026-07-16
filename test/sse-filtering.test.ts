/**
 * Unit tests for shouldApplySSEUpdate — client-side SSE filtering logic.
 *
 * Task 11.2: Implement client-side SSE filtering based on workspace selection
 * Requirements: 11.6, 11.6.1, 11.7
 */

import { describe, it, expect } from 'bun:test';
import { shouldApplySSEUpdate } from '../src/dashboard/sse-filter';
import type { SSEUpdateEvent } from '../src/dashboard/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(workspaceId?: string | null): SSEUpdateEvent {
  return {
    type: 'chain-update',
    workspaceId: workspaceId as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Requirement 11.7: "All Workspaces" selected — apply ALL updates
// ---------------------------------------------------------------------------

describe('shouldApplySSEUpdate — All Workspaces selected (selectedWorkspace = null)', () => {
  it('applies update when event has a matching workspaceId', () => {
    expect(shouldApplySSEUpdate(makeEvent('ws-alpha'), null)).toBe(true);
  });

  it('applies update when event has a different workspaceId', () => {
    expect(shouldApplySSEUpdate(makeEvent('ws-beta'), null)).toBe(true);
  });

  it('applies update when event has no workspaceId (missing)', () => {
    expect(shouldApplySSEUpdate(makeEvent(undefined), null)).toBe(true);
  });

  it('applies update when event has null workspaceId', () => {
    expect(shouldApplySSEUpdate(makeEvent(null), null)).toBe(true);
  });

  it('applies update when event has empty string workspaceId', () => {
    expect(shouldApplySSEUpdate(makeEvent(''), null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Requirement 11.6: specific workspace selected — apply only matching updates
// ---------------------------------------------------------------------------

describe('shouldApplySSEUpdate — specific workspace selected', () => {
  it('applies update when event workspaceId matches selected workspace', () => {
    expect(shouldApplySSEUpdate(makeEvent('ws-alpha'), 'ws-alpha')).toBe(true);
  });

  it('ignores update when event workspaceId does not match selected workspace', () => {
    expect(shouldApplySSEUpdate(makeEvent('ws-beta'), 'ws-alpha')).toBe(false);
  });

  it('ignores update when event workspaceId is a different valid workspace', () => {
    expect(shouldApplySSEUpdate(makeEvent('project-x'), 'project-y')).toBe(false);
  });

  it('comparison is case-sensitive — does not match different casing', () => {
    expect(shouldApplySSEUpdate(makeEvent('WS-Alpha'), 'ws-alpha')).toBe(false);
    expect(shouldApplySSEUpdate(makeEvent('ws-alpha'), 'WS-Alpha')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Requirement 11.6.1: update without workspaceId — apply to current view
// ---------------------------------------------------------------------------

describe('shouldApplySSEUpdate — update without workspaceId (Req 11.6.1)', () => {
  it('applies update when event has no workspaceId and specific workspace is selected', () => {
    expect(shouldApplySSEUpdate(makeEvent(undefined), 'ws-alpha')).toBe(true);
  });

  it('applies update when event has null workspaceId and specific workspace is selected', () => {
    expect(shouldApplySSEUpdate(makeEvent(null), 'ws-alpha')).toBe(true);
  });

  it('applies update when event has empty string workspaceId and specific workspace is selected', () => {
    expect(shouldApplySSEUpdate(makeEvent(''), 'ws-alpha')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// All SSE event types behave the same way
// ---------------------------------------------------------------------------

describe('shouldApplySSEUpdate — works for all event types', () => {
  const types = ['chain-update', 'job-update', 'session-update', 'git-update'] as const;

  for (const type of types) {
    it(`applies update for ${type} when All Workspaces selected`, () => {
      const event: SSEUpdateEvent = { type, workspaceId: 'ws-1' };
      expect(shouldApplySSEUpdate(event, null)).toBe(true);
    });

    it(`applies update for ${type} when workspaceId matches`, () => {
      const event: SSEUpdateEvent = { type, workspaceId: 'ws-1' };
      expect(shouldApplySSEUpdate(event, 'ws-1')).toBe(true);
    });

    it(`ignores update for ${type} when workspaceId differs`, () => {
      const event: SSEUpdateEvent = { type, workspaceId: 'ws-2' };
      expect(shouldApplySSEUpdate(event, 'ws-1')).toBe(false);
    });
  }
});
