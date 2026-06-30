// Feature: monitor-dashboard-redesign, Property 13: Toast stack bounded at 5
// Validates: Requirements 10.4, 10.6

import { describe, it, expect, beforeEach, beforeAll } from 'bun:test';
import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// DOM stub — toast.ts calls document.getElementById('toast-stack') in _render().
// Returning null makes _render() a no-op so queue logic is testable in isolation.
// ---------------------------------------------------------------------------

beforeAll(() => {
  // @ts-ignore — Bun has no DOM; provide a minimal global stub
  globalThis.document = {
    getElementById: (_id: string) => null,
    createElement: (_tag: string) => ({
      setAttribute: () => {},
      addEventListener: () => {},
      appendChild: () => {},
      style: {} as CSSStyleDeclaration,
      id: '',
    }) as unknown as HTMLElement,
  };
  // setTimeout / clearTimeout are available in Bun natively — no stub needed.
});

// ---------------------------------------------------------------------------
// Import toast module AFTER the global stub is set up (module-level side-effects
// only touch document inside functions, so this is safe).
// ---------------------------------------------------------------------------

import {
  enqueueToast,
  dismissToast,
  getToasts,
  clearToasts,
} from '../src/dashboard/toast.js';

// ---------------------------------------------------------------------------
// Inline Toast type (matches types.ts exactly)
// ---------------------------------------------------------------------------

interface Toast {
  id: string;
  type: 'success' | 'error';
  message: string;
  persistent: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _counter = 0;
function makeToast(type: Toast['type'], persistent?: boolean): Toast {
  _counter++;
  return {
    id: `t${_counter}`,
    type,
    message: `msg-${_counter}`,
    persistent: persistent ?? (type === 'error'),
  };
}

function makeSuccess(): Toast { return makeToast('success', false); }
function makeError():   Toast { return makeToast('error',   true);  }

// ---------------------------------------------------------------------------
// fast-check arbitraries
// ---------------------------------------------------------------------------

const toastTypeArb = fc.constantFrom<Toast['type']>('success', 'error');

/** Generate a toast; persistent matches the type convention. */
const toastArb: fc.Arbitrary<Toast> = toastTypeArb.chain((type) =>
  fc.record({
    id:         fc.uuid(),
    type:       fc.constant(type),
    message:    fc.string({ minLength: 1, maxLength: 80 }),
    persistent: fc.constant(type === 'error'),
  })
);

/** A non-empty array of 1–20 toasts of any mix. */
const toastSeqArb = fc.array(toastArb, { minLength: 1, maxLength: 20 });

// ---------------------------------------------------------------------------
// describe: Property 13 — Toast stack bounded at 5
// ---------------------------------------------------------------------------

describe('Property 13: Toast stack bounded at 5', () => {

  beforeEach(() => {
    clearToasts();
  });

  // -------------------------------------------------------------------------
  // Branch 1: stack never exceeds 5 for any sequence of enqueued toasts
  // -------------------------------------------------------------------------

  it('P13-a: stack never exceeds 5 after enqueuing any sequence of toasts', () => {
    fc.assert(
      fc.property(toastSeqArb, (toasts) => {
        clearToasts();
        for (const t of toasts) {
          enqueueToast(t);
          expect(getToasts().length).toBeLessThanOrEqual(5);
        }
      }),
      { numRuns: 100 }
    );
  });

  // -------------------------------------------------------------------------
  // Branch 2: when stack is full and a success toast exists, oldest success is
  // evicted to make room for the new toast
  // -------------------------------------------------------------------------

  it('P13-b: oldest success evicted when stack full and new toast arrives', () => {
    fc.assert(
      fc.property(
        // Generate a sequence of 0–3 error toasts followed by 5 - N success
        // toasts to fill the stack (total always 5), then one more incoming toast.
        fc.integer({ min: 0, max: 4 }).chain((numErrors) => {
          const numSuccesses = 5 - numErrors;     // stack will be full
          return fc.record({
            initialErrors:   fc.array(fc.uuid(), { minLength: numErrors,   maxLength: numErrors }),
            initialSuccesses: fc.array(fc.uuid(), { minLength: numSuccesses, maxLength: numSuccesses }),
            incoming:        toastArb,
          });
        }),
        ({ initialErrors, initialSuccesses, incoming }) => {
          clearToasts();

          // Fill the stack: errors first (oldest), then successes
          const filled: Toast[] = [
            ...initialErrors.map((id) => ({ id, type: 'error' as const, message: 'e', persistent: true })),
            ...initialSuccesses.map((id) => ({ id, type: 'success' as const, message: 's', persistent: false })),
          ];
          for (const t of filled) enqueueToast(t);
          expect(getToasts().length).toBe(5);

          const oldestSuccessId = initialSuccesses[0]; // first success pushed = oldest
          enqueueToast(incoming);

          const stackAfter = getToasts();
          // Stack must remain exactly 5
          expect(stackAfter.length).toBe(5);
          // The oldest success must have been evicted
          expect(stackAfter.some((t) => t.id === oldestSuccessId)).toBe(false);
          // The incoming toast must now be present
          expect(stackAfter.some((t) => t.id === incoming.id)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  // -------------------------------------------------------------------------
  // Branch 3: when only persistent error toasts remain, new toast is rejected
  // -------------------------------------------------------------------------

  it('P13-c: new toast rejected when stack full with only persistent errors', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uuid(), { minLength: 5, maxLength: 5 }),
        toastArb,
        (errorIds, incoming) => {
          clearToasts();

          // Fill stack with 5 persistent error toasts
          for (const id of errorIds) {
            enqueueToast({ id, type: 'error', message: 'e', persistent: true });
          }
          expect(getToasts().length).toBe(5);

          enqueueToast(incoming);

          const stackAfter = getToasts();
          // Stack stays at 5 — incoming rejected
          expect(stackAfter.length).toBe(5);
          // Incoming toast is NOT in the stack
          expect(stackAfter.some((t) => t.id === incoming.id)).toBe(false);
          // All original error toasts are still present
          for (const id of errorIds) {
            expect(stackAfter.some((t) => t.id === id)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // -------------------------------------------------------------------------
  // Example-based edge cases
  // -------------------------------------------------------------------------

  it('empty stack: single success toast is accepted', () => {
    const t = makeSuccess();
    enqueueToast(t);
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0].id).toBe(t.id);
  });

  it('empty stack: single error toast is accepted', () => {
    const t = makeError();
    enqueueToast(t);
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0].id).toBe(t.id);
  });

  it('filling to exactly 5 succeeds without eviction', () => {
    for (let i = 0; i < 5; i++) enqueueToast(makeSuccess());
    expect(getToasts()).toHaveLength(5);
  });

  it('6th toast evicts oldest success when all 5 are successes', () => {
    const first = makeSuccess();
    enqueueToast(first);
    for (let i = 0; i < 4; i++) enqueueToast(makeSuccess());
    expect(getToasts()).toHaveLength(5);

    const sixth = makeSuccess();
    enqueueToast(sixth);
    const stack = getToasts();
    expect(stack).toHaveLength(5);
    expect(stack.some((t) => t.id === first.id)).toBe(false);
    expect(stack.some((t) => t.id === sixth.id)).toBe(true);
  });

  it('5 errors: 6th toast rejected regardless of type', () => {
    for (let i = 0; i < 5; i++) enqueueToast(makeError());
    const extra = makeSuccess();
    enqueueToast(extra);
    expect(getToasts()).toHaveLength(5);
    expect(getToasts().some((t) => t.id === extra.id)).toBe(false);
  });

  it('mixed full stack (4 errors + 1 success): incoming evicts the success', () => {
    for (let i = 0; i < 4; i++) enqueueToast(makeError());
    const theSuccess = makeSuccess();
    enqueueToast(theSuccess);
    expect(getToasts()).toHaveLength(5);

    const incoming = makeError();
    enqueueToast(incoming);
    const stack = getToasts();
    expect(stack).toHaveLength(5);
    expect(stack.some((t) => t.id === theSuccess.id)).toBe(false);
    expect(stack.some((t) => t.id === incoming.id)).toBe(true);
  });

  it('clearToasts resets to empty stack', () => {
    for (let i = 0; i < 5; i++) enqueueToast(makeSuccess());
    clearToasts();
    expect(getToasts()).toHaveLength(0);
  });

  it('dismissToast removes a toast by id', () => {
    const a = makeSuccess();
    const b = makeSuccess();
    enqueueToast(a);
    enqueueToast(b);
    dismissToast(a.id);
    const stack = getToasts();
    expect(stack.some((t) => t.id === a.id)).toBe(false);
    expect(stack.some((t) => t.id === b.id)).toBe(true);
  });

});
