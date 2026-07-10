/**
 * Unit tests for debounce logic in startFileWatcher (Task 8.1)
 *
 * Tests the exported `createDebouncer` helper directly — no real filesystem
 * I/O or `fs.watch` required.  Fake timers from `bun:test` control time.
 *
 * Subtasks covered:
 *  8.1 — Debounce: rapid same-path → single call; distinct paths → independent timers
 *
 * Requirements: 2.5, 12.1
 */

import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { createDebouncer } from '../../src/workers/fileWatcher.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fresh debouncers map and a jest.fn() spy for each test. */
function makeFixture(delayMs = 500) {
  const debouncers = new Map<string, ReturnType<typeof setTimeout>>();
  const onFire = jest.fn<(path: string) => void>();
  const dispatch = createDebouncer(debouncers, onFire, delayMs);
  return { debouncers, onFire, dispatch };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('createDebouncer — debounce logic (Requirements 2.5, 12.1)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── 8.1 Test 1: rapid events for same path → only one sync call after 500ms ──

  it('rapid events for same path produce exactly one callback after 500ms', () => {
    const { onFire, dispatch } = makeFixture();

    const path = '/output/jobs/file-a.md';

    // Fire 3 rapid events for the same path
    dispatch(path);
    dispatch(path);
    dispatch(path);

    // Not yet fired — 499ms < 500ms
    jest.advanceTimersByTime(499);
    expect(onFire).not.toHaveBeenCalled();

    // Now at exactly 500ms — should have fired once
    jest.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith(path);
  });

  // ── 8.1 Test 2: distinct paths → independent debounce timers ────────────

  it('distinct paths have independent debounce timers, each firing once after 500ms', () => {
    const { onFire, dispatch } = makeFixture();

    const path1 = '/output/jobs/file-1.md';
    const path2 = '/output/jobs/file-2.md';

    dispatch(path1);
    dispatch(path2);

    // Before either fires
    jest.advanceTimersByTime(499);
    expect(onFire).not.toHaveBeenCalled();

    // Both should fire at 500ms
    jest.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(2);
    expect(onFire).toHaveBeenCalledWith(path1);
    expect(onFire).toHaveBeenCalledWith(path2);
  });

  // ── 8.1 Test 3: debounce resets when a new event arrives before timeout ──

  it('debounce window resets when a new event arrives before timeout expires', () => {
    const { onFire, dispatch } = makeFixture();

    const path = '/output/jobs/file-x.md';

    // First event at t=0
    dispatch(path);

    // Second event at t=400 (before 500ms window closes)
    jest.advanceTimersByTime(400);
    dispatch(path);
    expect(onFire).not.toHaveBeenCalled();

    // At t=899 (400 + 499) — still not fired (window reset at t=400, needs 500 more)
    jest.advanceTimersByTime(499);
    expect(onFire).not.toHaveBeenCalled();

    // At t=900 (400 + 500) — now fires exactly once
    jest.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith(path);
  });

  // ── 8.1 Test 4: map is cleaned up after timer fires ─────────────────────

  it('path is removed from debouncers map after the timer fires', () => {
    const { debouncers, dispatch } = makeFixture();

    const path = '/output/jobs/cleanup-test.md';

    dispatch(path);
    expect(debouncers.has(path)).toBe(true);

    jest.advanceTimersByTime(500);
    expect(debouncers.has(path)).toBe(false);
  });

  // ── 8.1 Test 5: N rapid events → single callback (property-style) ───────

  it('any number of rapid events for the same path triggers exactly one callback', () => {
    const { onFire, dispatch } = makeFixture();

    const path = '/output/jobs/rapid.md';

    // Simulate 10 rapid events with 10ms gaps (all within the 500ms window)
    for (let i = 0; i < 10; i++) {
      dispatch(path);
      jest.advanceTimersByTime(10);
    }

    // Total time advanced: 100ms — well within 500ms window, so not fired yet
    expect(onFire).not.toHaveBeenCalled();

    // Advance past the final 500ms window
    jest.advanceTimersByTime(500);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  // ── 8.1 Test 6: existing timer is cleared before setting new one ─────────

  it('clears the existing timer before setting a new one on re-dispatch', () => {
    const { debouncers, dispatch } = makeFixture();

    const path = '/output/jobs/clear-test.md';

    dispatch(path);
    const firstTimer = debouncers.get(path);
    expect(firstTimer).toBeDefined();

    // Dispatch again before timeout
    jest.advanceTimersByTime(100);
    dispatch(path);
    const secondTimer = debouncers.get(path);
    expect(secondTimer).toBeDefined();

    // The timer handle should be different after re-dispatch
    expect(secondTimer).not.toBe(firstTimer);
  });
});
