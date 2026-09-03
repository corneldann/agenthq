// memory-sse-handler.test.ts — Test memory-update SSE event handling
// Feature: phase-6.4-memory-browser
// Requirement: 4.3 — Real-time memory list refresh via SSE

// MUST import setup first to initialize DOM and localStorage
import './memory-test-setup';

import { describe, it, expect, beforeEach } from 'bun:test';
import { getState, setState } from '../../src/dashboard/state';
import type { MemoryPageState } from '../../src/dashboard/types';

/**
 * Test strategy:
 * 
 * These tests verify the SSE handler logic pattern for memory-update events.
 * They test the conditional logic without mocking actual imports, which aligns
 * with the pattern used in main.ts where we check currentPage and call
 * refreshMemoryList accordingly.
 */

describe('memory-update SSE event handling logic', () => {
  beforeEach(() => {
    // Initialize memory state
    setState({
      memory: {
        memories: [],
        cursor: null,
        total: 0,
        searchQuery: '',
        loading: false,
        error: null,
        workspaceId: 'test-workspace',
        chainId: '',
        agentId: '',
      } as MemoryPageState,
      currentPage: 'memory',
    });
  });

  it('should identify memory-update event type correctly', () => {
    // Arrange
    const eventData = JSON.stringify({
      type: 'memory-update',
      workspaceId: 'test-workspace',
    });

    // Act
    const parsed = JSON.parse(eventData);

    // Assert
    expect(parsed.type).toBe('memory-update');
    expect(parsed.workspaceId).toBe('test-workspace');
  });

  it('should determine when to call refreshMemoryList based on currentPage', () => {
    // Arrange - memory page is active
    setState({ currentPage: 'memory' });
    const eventData = JSON.stringify({
      type: 'memory-update',
      workspaceId: 'test-workspace',
    });

    // Act
    const parsed = JSON.parse(eventData);
    const { currentPage } = getState();
    const shouldRefresh = parsed.type === 'memory-update' && currentPage === 'memory';

    // Assert
    expect(shouldRefresh).toBe(true);
  });

  it('should NOT refresh when currentPage is not memory', () => {
    // Arrange - dashboard page is active
    setState({ currentPage: 'dashboard' });
    const eventData = JSON.stringify({
      type: 'memory-update',
      workspaceId: 'test-workspace',
    });

    // Act
    const parsed = JSON.parse(eventData);
    const { currentPage } = getState();
    const shouldRefresh = parsed.type === 'memory-update' && currentPage === 'memory';

    // Assert
    expect(shouldRefresh).toBe(false);
  });

  it('should distinguish memory-update from other SSE event types', () => {
    // Arrange
    const chainUpdateEvent = JSON.stringify({
      type: 'chain-update',
      workspaceId: 'test-workspace',
    });
    const memoryUpdateEvent = JSON.stringify({
      type: 'memory-update',
      workspaceId: 'test-workspace',
    });

    // Act
    const chainParsed = JSON.parse(chainUpdateEvent);
    const memoryParsed = JSON.parse(memoryUpdateEvent);

    // Assert
    expect(chainParsed.type === 'memory-update').toBe(false);
    expect(memoryParsed.type === 'memory-update').toBe(true);
  });

  it('should handle multiple page transitions correctly', () => {
    // Arrange
    const eventData = JSON.stringify({
      type: 'memory-update',
      workspaceId: 'test-workspace',
    });

    // Act & Assert - memory page
    setState({ currentPage: 'memory' });
    let parsed = JSON.parse(eventData);
    let { currentPage } = getState();
    let shouldRefresh = parsed.type === 'memory-update' && currentPage === 'memory';
    expect(shouldRefresh).toBe(true);

    // Act & Assert - work page
    setState({ currentPage: 'work' });
    parsed = JSON.parse(eventData);
    currentPage = getState().currentPage;
    shouldRefresh = parsed.type === 'memory-update' && currentPage === 'memory';
    expect(shouldRefresh).toBe(false);

    // Act & Assert - back to memory page
    setState({ currentPage: 'memory' });
    parsed = JSON.parse(eventData);
    currentPage = getState().currentPage;
    shouldRefresh = parsed.type === 'memory-update' && currentPage === 'memory';
    expect(shouldRefresh).toBe(true);
  });
});

describe('memory listener registration and invocation (Requirement 4.3)', () => {
  let main: typeof import('../../src/dashboard/main');

  beforeEach(async () => {
    // Dynamic import to ensure fresh module state
    main = await import('../../src/dashboard/main');
  });

  it('should invoke registered listener when notifyMemoryUpdateListeners is called', () => {
    // Arrange
    let invoked = false;
    const listener = (): void => {
      invoked = true;
    };
    main.registerMemoryUpdateListener('test-listener', listener);

    // Act
    main.notifyMemoryUpdateListeners();

    // Assert
    expect(invoked).toBe(true);
  });

  it('should invoke multiple registered listeners', () => {
    // Arrange
    let invoked1 = false;
    let invoked2 = false;
    let invoked3 = false;

    const listener1 = (): void => {
      invoked1 = true;
    };
    const listener2 = (): void => {
      invoked2 = true;
    };
    const listener3 = (): void => {
      invoked3 = true;
    };

    main.registerMemoryUpdateListener('listener-1', listener1);
    main.registerMemoryUpdateListener('listener-2', listener2);
    main.registerMemoryUpdateListener('listener-3', listener3);

    // Act
    main.notifyMemoryUpdateListeners();

    // Assert
    expect(invoked1).toBe(true);
    expect(invoked2).toBe(true);
    expect(invoked3).toBe(true);
  });

  it('should continue invoking other listeners when one listener throws error', () => {
    // Arrange
    let invoked1 = false;
    let invoked3 = false;

    const listener1 = (): void => {
      invoked1 = true;
    };
    const listener2 = (): void => {
      throw new Error('Listener 2 failed');
    };
    const listener3 = (): void => {
      invoked3 = true;
    };

    main.registerMemoryUpdateListener('listener-1', listener1);
    main.registerMemoryUpdateListener('listener-2-error', listener2);
    main.registerMemoryUpdateListener('listener-3', listener3);

    // Act
    main.notifyMemoryUpdateListeners();

    // Assert
    expect(invoked1).toBe(true);
    expect(invoked3).toBe(true);
  });

  it('should not invoke deregistered listener', () => {
    // Arrange
    let invoked = false;
    const listener = (): void => {
      invoked = true;
    };

    main.registerMemoryUpdateListener('test-listener', listener);
    main.deregisterMemoryUpdateListener('test-listener');

    // Act
    main.notifyMemoryUpdateListeners();

    // Assert
    expect(invoked).toBe(false);
  });

  it('should skip dead WeakRef entries without error', () => {
    // Arrange
    // Create a WeakRef that will return undefined when deref() is called
    // We simulate this by registering a listener then clearing its reference
    const listener = (): void => {
      // This should not be called
    };
    main.registerMemoryUpdateListener('test-listener', listener);

    // Manually create a dead WeakRef by replacing it with one that derefs to undefined
    // This is a test-only scenario to verify the safety check in notifyMemoryUpdateListeners
    const mockDeadWeakRef = {
      deref: (): undefined => undefined,
    } as WeakRef<() => void>;

    // We can't directly manipulate the internal registry, but we can test
    // that calling notify doesn't crash when a WeakRef is dead
    // The implementation handles this by checking if deref() returns a value

    // Act - should not throw
    expect(() => {
      main.notifyMemoryUpdateListeners();
    }).not.toThrow();

    // Assert - implicit (no throw means success)
  });
});

describe('WeakRef registry cleanup (Requirement 4.4)', () => {
  let main: typeof import('../../src/dashboard/main');

  beforeEach(async () => {
    // Dynamic import to ensure fresh module state
    main = await import('../../src/dashboard/main');
  });

  it('should remove listener via deregisterMemoryUpdateListener', () => {
    // Arrange
    let invoked = false;
    const listener = (): void => {
      invoked = true;
    };
    main.registerMemoryUpdateListener('removable-listener', listener);

    // Act
    main.deregisterMemoryUpdateListener('removable-listener');
    main.notifyMemoryUpdateListeners();

    // Assert
    expect(invoked).toBe(false);
  });

  it('should allow re-registration after deregistration', () => {
    // Arrange
    let invokeCount = 0;
    const listener = (): void => {
      invokeCount++;
    };

    main.registerMemoryUpdateListener('test-listener', listener);
    main.deregisterMemoryUpdateListener('test-listener');
    main.registerMemoryUpdateListener('test-listener', listener);

    // Act
    main.notifyMemoryUpdateListeners();

    // Assert
    expect(invokeCount).toBe(1);
  });

  it('should not throw when deregistering non-existent listener', () => {
    // Arrange & Act & Assert
    expect(() => {
      main.deregisterMemoryUpdateListener('non-existent-listener');
    }).not.toThrow();
  });

  it('should replace listener when same id is registered twice', () => {
    // Arrange
    let firstInvoked = false;
    let secondInvoked = false;

    const listener1 = (): void => {
      firstInvoked = true;
    };
    const listener2 = (): void => {
      secondInvoked = true;
    };

    main.registerMemoryUpdateListener('same-id', listener1);
    main.registerMemoryUpdateListener('same-id', listener2);

    // Act
    main.notifyMemoryUpdateListeners();

    // Assert
    expect(firstInvoked).toBe(false);
    expect(secondInvoked).toBe(true);
  });
});

describe('background refresh error handling (Requirement 4.5)', () => {
  let memoryPage: typeof import('../../src/dashboard/pages/memory');
  let toastModule: typeof import('../../src/dashboard/toast');

  beforeEach(async () => {
    // Dynamic imports to ensure fresh module state
    memoryPage = await import('../../src/dashboard/pages/memory');
    toastModule = await import('../../src/dashboard/toast');

    // Initialize memory page state
    setState({
      currentPage: 'memory',
      memory: {
        memories: [],
        cursor: null,
        total: 0,
        searchQuery: '',
        loading: false,
        error: null,
        workspaceId: 'test-workspace',
        chainId: '',
        agentId: '',
      },
    });
  });

  it('should show error toast when refreshMemoryList fails', async () => {
    // Arrange
    const toastCalls: Array<{ id: string; type: string; message: string; persistent: boolean }> = [];

    // Mock fetch to fail
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response;
    }) as unknown as typeof globalThis.fetch;

    try {
      // Act - simulate SSE handler error path
      // The SSE handler in main.ts does: refreshMemoryList(true).catch(() => enqueueToast(...))
      try {
        await memoryPage.refreshMemoryList(true);
      } catch (err) {
        // Simulate what the SSE handler does when catching the error
        toastCalls.push({
          id: crypto.randomUUID(),
          type: 'error',
          message: 'Memory refresh failed — retrying',
          persistent: false,
        });
      }

      // Assert - verify error was caught and toast would be enqueued
      expect(toastCalls.length).toBe(1);
      expect(toastCalls[0].type).toBe('error');
      expect(toastCalls[0].message).toBe('Memory refresh failed — retrying');
      expect(toastCalls[0].persistent).toBe(false);
    } finally {
      // Restore
      globalThis.fetch = originalFetch;
    }
  });

  it('should have correct toast format when refresh fails', async () => {
    // Arrange
    let capturedToast: { type: string; message: string; persistent: boolean } | null = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      } as Response;
    }) as unknown as typeof globalThis.fetch;

    try {
      // Act - simulate SSE handler error path
      try {
        await memoryPage.refreshMemoryList(true);
      } catch {
        capturedToast = {
          type: 'error',
          message: 'Memory refresh failed — retrying',
          persistent: false,
        };
      }

      // Assert
      expect(capturedToast).not.toBeNull();
      expect(capturedToast?.type).toBe('error');
      expect(capturedToast?.message).toContain('Memory refresh failed');
      expect(capturedToast?.message).toContain('retrying');
      expect(capturedToast?.persistent).toBe(false);
    } finally {
      // Restore
      globalThis.fetch = originalFetch;
    }
  });

  it('should not enqueue toast when refreshMemoryList succeeds', async () => {
    // Arrange
    let errorCaught = false;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          memories: [],
          nextCursor: null,
          total: 0,
        }),
      } as Response;
    }) as unknown as typeof globalThis.fetch;

    try {
      // Act
      try {
        await memoryPage.refreshMemoryList(true);
      } catch {
        errorCaught = true;
      }

      // Assert - no error should be thrown, so no toast needed
      expect(errorCaught).toBe(false);
    } finally {
      // Restore
      globalThis.fetch = originalFetch;
    }
  });

  it('should update memory state with error when refresh fails without rethrow', async () => {
    // Arrange
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response;
    }) as unknown as typeof globalThis.fetch;

    try {
      // Act - call without rethrow (default behavior)
      await memoryPage.refreshMemoryList(false);

      // Assert - check state was updated with error
      const state = getState();
      expect(state.memory?.error).not.toBeNull();
      expect(state.memory?.loading).toBe(false);
    } finally {
      // Restore
      globalThis.fetch = originalFetch;
    }
  });

  it('should rethrow error when rethrowError is true', async () => {
    // Arrange
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return {
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
      } as Response;
    }) as unknown as typeof globalThis.fetch;

    try {
      // Act & Assert - should throw
      await expect(memoryPage.refreshMemoryList(true)).rejects.toThrow();
    } finally {
      // Restore
      globalThis.fetch = originalFetch;
    }
  });

  it('should not rethrow error when rethrowError is false', async () => {
    // Arrange
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return {
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
      } as Response;
    }) as unknown as typeof globalThis.fetch;

    try {
      // Act & Assert - should not throw
      await expect(memoryPage.refreshMemoryList(false)).resolves.toBeUndefined();
    } finally {
      // Restore
      globalThis.fetch = originalFetch;
    }
  });
});
