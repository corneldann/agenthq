// test/dashboard/memory-test-setup.ts
// Setup file for memory page tests - must run before any imports

// happy-dom for DOM environment
import { Window } from 'happy-dom';

const window = new Window();
const document = window.document;

// Expose global DOM APIs
(globalThis as Record<string, unknown>).window = window;
(globalThis as Record<string, unknown>).document = document;
(globalThis as Record<string, unknown>).HTMLElement = window.HTMLElement;
(globalThis as Record<string, unknown>).Element = window.Element;
(globalThis as Record<string, unknown>).Event = window.Event;
(globalThis as Record<string, unknown>).CustomEvent = window.CustomEvent;

// Mock EventSource for SSE tests
class MockEventSource {
  url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState: number = 0;
  
  constructor(url: string) {
    this.url = url;
  }
  
  addEventListener(): void {
    // Mock implementation
  }
  
  removeEventListener(): void {
    // Mock implementation
  }
  
  close(): void {
    // Mock implementation
  }
}

(globalThis as Record<string, unknown>).EventSource = MockEventSource;

// localStorage mock — MUST be set up before any imports
const localStorageStore: Record<string, string> = {};

const localStorageMock = {
  getItem: (key: string): string | null => localStorageStore[key] ?? null,
  setItem: (key: string, value: string): void => { localStorageStore[key] = value; },
  removeItem: (key: string): void => { delete localStorageStore[key]; },
  clear: (): void => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
};

// Inject mock before modules are loaded
(globalThis as Record<string, unknown>).localStorage = localStorageMock;

export { localStorageMock };
