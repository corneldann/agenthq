// memory-page-search.test.ts — test debounced search input functionality
// Phase 6.4 Memory Browser
// Requirement 2.3: Debounced search input with 300ms delay

import { describe, it, expect, beforeEach, mock, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { renderMemoryPage, initMemoryPage } from '../../src/dashboard/pages/memory.js';
import { setState, getState } from '../../src/dashboard/state.js';
import type { Memory, MemoryScope } from '../../src/dashboard/types.js';

describe('Memory page — debounced search', () => {
  let window: Window;
  let container: HTMLElement;

  beforeEach(() => {
    // Create a minimal DOM environment
    window = new Window();
    global.document = window.document as unknown as Document;
    global.window = window as unknown as Window & typeof globalThis;
    global.HTMLElement = window.HTMLElement;
    global.Element = window.Element;
    global.Node = window.Node;

    // Mount the page
    container = window.document.body;
    container.innerHTML = renderMemoryPage();

    // Mock fetch
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            memories: [],
            nextCursor: null,
            total: 0,
          }),
      } as Response)
    );

    // Initialize the page
    initMemoryPage();
  });

  afterEach(() => {
    // Clean up
    if (container) {
      container.innerHTML = '';
    }
  });

  it('should render search input with correct ARIA attributes', () => {
    const searchInput = window.document.getElementById('memory-search-input') as HTMLInputElement | null;

    expect(searchInput).toBeTruthy();
    expect(searchInput?.getAttribute('type')).toBe('text');
    expect(searchInput?.getAttribute('aria-label')).toBe('Search memories');
    expect(searchInput?.getAttribute('placeholder')).toBe('Search memories...');
  });

  it('should trigger search after 300ms debounce delay', async () => {
    const searchInput = window.document.getElementById('memory-search-input') as HTMLInputElement | null;
    expect(searchInput).toBeTruthy();

    if (!searchInput) return;

    // Clear the initial fetch call from initMemoryPage
    (global.fetch as ReturnType<typeof mock>).mockClear();

    // Type in the search input
    searchInput.value = 'test query';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));

    // Check that fetch is NOT called immediately
    expect((global.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(0);

    // Wait 150ms (half of debounce delay)
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((global.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(0);

    // Wait another 200ms (total 350ms, past debounce delay)
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Now fetch should have been called
    expect((global.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(1);

    // Verify the API call was made with correct parameters
    const callUrl = (global.fetch as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(callUrl).toContain('/api/memory/search');
    expect(callUrl).toContain('q=test+query');
  });

  it('should cancel previous debounce timer when typing continues', async () => {
    const searchInput = window.document.getElementById('memory-search-input') as HTMLInputElement | null;
    expect(searchInput).toBeTruthy();

    if (!searchInput) return;

    // Clear the initial fetch call
    (global.fetch as ReturnType<typeof mock>).mockClear();

    // Type first query
    searchInput.value = 'first';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));

    // Wait 150ms
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Type second query (should cancel first debounce)
    searchInput.value = 'second';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));

    // Wait another 150ms
    await new Promise((resolve) => setTimeout(resolve, 150));

    // No fetch call yet (only 300ms total, but timer was reset)
    expect((global.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(0);

    // Wait another 200ms (now 350ms from second input)
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should have only ONE fetch call (for "second" query)
    expect((global.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    const callUrl = (global.fetch as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(callUrl).toContain('q=second');
  });

  it('should clear search and return to list view when input is emptied', async () => {
    const searchInput = window.document.getElementById('memory-search-input') as HTMLInputElement | null;
    expect(searchInput).toBeTruthy();

    if (!searchInput) return;

    // Set initial memory state with a search query
    setState({
      memory: {
        memories: [
          {
            id: 'mem-1',
            text: 'Search result',
            scope: { workspaceId: 'ws-1' },
            qualityScore: 0.9,
            createdAt: '2024-01-01T00:00:00Z',
            lastRetrievedAt: '2024-01-01T00:00:00Z',
            retrievalCount: 1,
            tier: 'hot',
            embeddingStatus: 'ready',
          } as Memory,
        ],
        cursor: null,
        total: 1,
        searchQuery: 'test',
        loading: false,
        error: null,
        workspaceId: '',
        chainId: '',
        agentId: '',
      },
    });

    // Clear the initial fetch calls
    (global.fetch as ReturnType<typeof mock>).mockClear();

    // Mock the list endpoint response
    (global.fetch as ReturnType<typeof mock>).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          memories: [],
          nextCursor: null,
          total: 0,
        }),
    } as Response);

    // Clear the search input
    searchInput.value = '';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));

    // Should call list endpoint immediately (no debounce for clearing)
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((global.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    const callUrl = (global.fetch as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(callUrl).toContain('/api/memory/list');

    // Check that state was updated
    const state = getState();
    expect(state.memory?.searchQuery).toBe('');
  });

  it('should include workspaceId filter in search request', async () => {
    const searchInput = window.document.getElementById('memory-search-input') as HTMLInputElement | null;
    expect(searchInput).toBeTruthy();

    if (!searchInput) return;

    // Set workspace filter
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
      },
    });

    // Clear the initial fetch calls
    (global.fetch as ReturnType<typeof mock>).mockClear();

    // Type in the search input
    searchInput.value = 'test query';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));

    // Wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect((global.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    const callUrl = (global.fetch as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(callUrl).toContain('/api/memory/search');
    expect(callUrl).toContain('workspaceId=test-workspace');
  });

  it('should handle search API errors gracefully', async () => {
    const searchInput = window.document.getElementById('memory-search-input') as HTMLInputElement | null;
    expect(searchInput).toBeTruthy();

    if (!searchInput) return;

    // Clear the initial fetch calls
    (global.fetch as ReturnType<typeof mock>).mockClear();

    // Mock fetch to return error
    (global.fetch as ReturnType<typeof mock>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as Response);

    // Type in the search input
    searchInput.value = 'test';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));

    // Wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 350));

    // Check that error state was set
    const state = getState();
    expect(state.memory?.loading).toBe(false);
    expect(state.memory?.error).toContain('500');
  });

  it('should set loading state while search is in progress', async () => {
    const searchInput = window.document.getElementById('memory-search-input') as HTMLInputElement | null;
    expect(searchInput).toBeTruthy();

    if (!searchInput) return;

    // Clear the initial fetch calls
    (global.fetch as ReturnType<typeof mock>).mockClear();

    // Mock slow fetch
    let resolveSearch: (value: Response) => void;
    const searchPromise = new Promise<Response>((resolve) => {
      resolveSearch = resolve;
    });
    (global.fetch as ReturnType<typeof mock>).mockReturnValueOnce(searchPromise);

    // Type in the search input
    searchInput.value = 'test';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));

    // Wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 350));

    // Check that loading state is true
    let state = getState();
    expect(state.memory?.loading).toBe(true);
    expect(state.memory?.searchQuery).toBe('test');

    // Resolve the fetch
    resolveSearch!({
      ok: true,
      json: () => Promise.resolve([]),
    } as Response);

    // Wait for state update
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Loading should now be false
    state = getState();
    expect(state.memory?.loading).toBe(false);
  });
});
