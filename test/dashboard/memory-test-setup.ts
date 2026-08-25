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
