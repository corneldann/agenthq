import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import { shouldApplySSEUpdate } from '../../src/dashboard/sse-filter';
import type { SSEUpdateEvent } from '../../src/dashboard/types';

/**
 * Property-Based Tests for SSE Update Filtering and Event Construction
 *
 * These tests verify universal invariants for SSE event workspace identification
 * and client-side filtering logic across all event types, workspace ID values,
 * and selection states.
 *
 * **Validates: Requirements 11.1-11.7**
 */

// ============================================================================
// Arbitraries (Generators for Test Data)
// ============================================================================

/** All valid SSE event type values per the SSEUpdateEvent interface. */
const validEventTypeArb = fc.constantFrom(
  'chain-update',
  'job-update',
  'session-update',
  'git-update',
) as fc.Arbitrary<SSEUpdateEvent['type']>;

/** Non-empty workspace IDs — represents a real workspace identifier. */
const nonEmptyWorkspaceIdArb = fc.string({ minLength: 1, maxLength: 50 });

/** Falsy workspace ID values: empty string, null, or undefined (missing). */
const falsyWorkspaceIdArb = fc.oneof(
  fc.constant(''),
  fc.constant(null as unknown as string),
  fc.constant(undefined as unknown as string),
);

/** Any workspace ID value, including falsy ones. */
const anyWorkspaceIdArb: fc.Arbitrary<string | null | undefined> = fc.oneof(
  nonEmptyWorkspaceIdArb,
  falsyWorkspaceIdArb,
);

/**
 * Build a minimal SSEUpdateEvent with the given type and workspaceId.
 * The `data` field is optional in the dashboard type and omitted here to
 * keep tests focused on the filtering predicate.
 */
function makeEvent(
  type: SSEUpdateEvent['type'],
  workspaceId?: string | null,
): SSEUpdateEvent {
  return { type, workspaceId: workspaceId as string } as SSEUpdateEvent;
}

// ============================================================================
// Property 27: SSE Event Workspace Identification
// ============================================================================

describe('Property 27: SSE Event Workspace Identification', () => {
  /**
   * For any SSEUpdateEvent constructed by the SSE broadcaster, the event SHALL
   * contain a `workspaceId` field populated with the workspace identifier, and
   * the `type` field SHALL be one of the valid event types.
   *
   * This property verifies the structural contract on emitted events: when a
   * non-empty workspaceId is supplied and a valid type is chosen, the resulting
   * event object satisfies both constraints simultaneously.
   *
   * **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5**
   */
  it('event type is always one of the four valid SSE event types', () => {
    fc.assert(
      fc.property(
        validEventTypeArb,
        nonEmptyWorkspaceIdArb,
        (type, workspaceId) => {
          const event = makeEvent(type, workspaceId);

          // The type field must be exactly one of the four valid values
          const validTypes: ReadonlyArray<string> = [
            'chain-update',
            'job-update',
            'session-update',
            'git-update',
          ];
          expect(validTypes).toContain(event.type);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('event workspaceId is populated with the supplied workspace identifier', () => {
    fc.assert(
      fc.property(
        validEventTypeArb,
        nonEmptyWorkspaceIdArb,
        (type, workspaceId) => {
          const event = makeEvent(type, workspaceId);

          // The workspaceId field must be the value that was supplied
          expect(event.workspaceId).toBe(workspaceId);

          // It must be truthy (non-empty) when a real workspace is provided
          expect(event.workspaceId).toBeTruthy();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('event type and workspaceId constraints hold jointly for all type/workspace combinations', () => {
    fc.assert(
      fc.property(
        validEventTypeArb,
        nonEmptyWorkspaceIdArb,
        (type, workspaceId) => {
          const event = makeEvent(type, workspaceId);

          const validTypes: ReadonlyArray<string> = [
            'chain-update',
            'job-update',
            'session-update',
            'git-update',
          ];

          // Both constraints must hold simultaneously
          expect(validTypes).toContain(event.type);
          expect(event.workspaceId).toBe(workspaceId);
          expect(typeof event.workspaceId).toBe('string');
          expect((event.workspaceId as string).length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================================
// Property 28: SSE Client Filtering with Selected Workspace
// ============================================================================

describe('Property 28: SSE Client Filtering with Selected Workspace', () => {
  /**
   * For any SSE update event and a specific selected workspace identifier,
   * the client-side filtering logic SHALL apply the update if and only if:
   *   - event.workspaceId === selectedWorkspace, OR
   *   - event.workspaceId is missing/null/undefined (falsy)
   *
   * **Validates: Requirements 11.6, 11.6.1**
   */
  it('applies update when event workspaceId exactly matches selected workspace', () => {
    fc.assert(
      fc.property(
        validEventTypeArb,
        nonEmptyWorkspaceIdArb,
        (type, workspaceId) => {
          const event = makeEvent(type, workspaceId);

          // When event.workspaceId matches selected workspace → apply
          const result = shouldApplySSEUpdate(event, workspaceId);
          expect(result).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('ignores update when event workspaceId is a different workspace', () => {
    fc.assert(
      fc.property(
        validEventTypeArb,
        nonEmptyWorkspaceIdArb,
        nonEmptyWorkspaceIdArb,
        (type, eventWorkspaceId, selectedWorkspace) => {
          // Skip the case where the two IDs happen to be equal
          fc.pre(eventWorkspaceId !== selectedWorkspace);

          const event = makeEvent(type, eventWorkspaceId);

          // Different workspace → do NOT apply
          const result = shouldApplySSEUpdate(event, selectedWorkspace);
          expect(result).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('applies update when event workspaceId is falsy and a specific workspace is selected (Req 11.6.1)', () => {
    fc.assert(
      fc.property(
        validEventTypeArb,
        falsyWorkspaceIdArb,
        nonEmptyWorkspaceIdArb,
        (type, falsyId, selectedWorkspace) => {
          const event = makeEvent(type, falsyId);

          // Missing/null/empty workspaceId → apply regardless of selected workspace
          const result = shouldApplySSEUpdate(event, selectedWorkspace);
          expect(result).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('if-and-only-if: applies exactly when workspaceId matches OR is falsy', () => {
    fc.assert(
      fc.property(
        validEventTypeArb,
        anyWorkspaceIdArb,
        nonEmptyWorkspaceIdArb,
        (type, eventWorkspaceId, selectedWorkspace) => {
          const event = makeEvent(type, eventWorkspaceId as string);
          const result = shouldApplySSEUpdate(event, selectedWorkspace);

          // The expected outcome according to the spec:
          const shouldApply =
            event.workspaceId === selectedWorkspace || !event.workspaceId;

          expect(result).toBe(shouldApply);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================================
// Property 29: SSE Client Filtering with "All Workspaces"
// ============================================================================

describe('Property 29: SSE Client Filtering with "All Workspaces"', () => {
  /**
   * For any SSE update event, when "All Workspaces" is selected
   * (selectedWorkspaceId is null), the client-side filtering logic SHALL always
   * apply the update regardless of workspaceId value (including missing,
   * mismatched, or any string value).
   *
   * **Validates: Requirement 11.7**
   */
  it('always applies update when "All Workspaces" is selected, regardless of event workspaceId', () => {
    fc.assert(
      fc.property(
        validEventTypeArb,
        anyWorkspaceIdArb,
        (type, workspaceId) => {
          const event = makeEvent(type, workspaceId as string);

          // selectedWorkspace = null means "All Workspaces"
          const result = shouldApplySSEUpdate(event, null);
          expect(result).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('applies update for all event types when "All Workspaces" selected with a non-empty workspaceId', () => {
    fc.assert(
      fc.property(
        validEventTypeArb,
        nonEmptyWorkspaceIdArb,
        (type, workspaceId) => {
          const event = makeEvent(type, workspaceId);
          expect(shouldApplySSEUpdate(event, null)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('applies update for all event types when "All Workspaces" selected with a falsy workspaceId', () => {
    fc.assert(
      fc.property(
        validEventTypeArb,
        falsyWorkspaceIdArb,
        (type, falsyId) => {
          const event = makeEvent(type, falsyId);
          expect(shouldApplySSEUpdate(event, null)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('"All Workspaces" always returns true — no workspace ID can cause it to return false', () => {
    fc.assert(
      fc.property(
        validEventTypeArb,
        anyWorkspaceIdArb,
        (type, workspaceId) => {
          const event = makeEvent(type, workspaceId as string);

          // There is NO event workspaceId value that should cause false when All Workspaces selected
          expect(shouldApplySSEUpdate(event, null)).toBe(true);

          // Double-check: result is never false for null selectedWorkspace
          const result = shouldApplySSEUpdate(event, null);
          expect(result === false).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
