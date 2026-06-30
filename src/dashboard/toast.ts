// toast.ts — toast queue, DOM stack rendering, auto-dismiss timers
// Feature: monitor-dashboard-redesign
// Implements Requirements 10.1–10.7

import type { Toast } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOASTS = 5;
const SUCCESS_DISMISS_MS = 4_000;
const ANIMATE_OUT_MS = 300;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Internal stack — index 0 is oldest, last index is newest. */
const _stack: Toast[] = [];

/** Pending auto-dismiss timers keyed by toast id. */
const _timers = new Map<string, ReturnType<typeof setTimeout>>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape HTML to prevent XSS when rendering user-sourced messages. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Resolve the #toast-stack DOM element, lazily. */
function getContainer(): HTMLElement | null {
  return document.getElementById('toast-stack');
}

// ---------------------------------------------------------------------------
// DOM rendering
// ---------------------------------------------------------------------------

/**
 * Build a single toast element and attach the dismiss handler.
 * The element starts visible; calling _animateOut() fades it before removal.
 */
function _buildElement(toast: Toast): HTMLElement {
  const el = document.createElement('div');
  el.id = `toast-${toast.id}`;
  el.setAttribute('role', 'alert');
  el.setAttribute('aria-live', toast.type === 'error' ? 'assertive' : 'polite');

  const isError = toast.type === 'error';

  el.style.cssText = [
    'display:flex',
    'align-items:flex-start',
    'gap:10px',
    'padding:10px 12px',
    'border-radius:6px',
    'border:1px solid',
    'max-width:360px',
    'font-family:ui-monospace,SFMono-Regular,Consolas,monospace',
    'font-size:13px',
    'line-height:1.4',
    'box-shadow:0 4px 12px rgba(0,0,0,0.4)',
    'opacity:1',
    'transition:opacity 0.3s ease, transform 0.3s ease',
    'transform:translateY(0)',
    isError
      ? 'background:#2d1b1b;border-color:#7f1d1d;color:#fca5a5'
      : 'background:#1a2e1a;border-color:#14532d;color:#86efac',
  ].join(';');

  // Icon span
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.style.cssText = 'flex-shrink:0;font-size:14px;margin-top:1px';
  icon.textContent = isError ? '✖' : '✔';

  // Message span
  const msg = document.createElement('span');
  msg.style.cssText = 'flex:1;word-break:break-word';
  msg.innerHTML = esc(toast.message);

  // Dismiss button — visible on every toast (Req 10.7)
  const btn = document.createElement('button');
  btn.setAttribute('aria-label', 'Dismiss notification');
  btn.style.cssText = [
    'flex-shrink:0',
    'background:none',
    'border:none',
    'cursor:pointer',
    'padding:0 2px',
    'font-size:16px',
    'line-height:1',
    'opacity:0.7',
    isError ? 'color:#fca5a5' : 'color:#86efac',
  ].join(';');
  btn.textContent = '×';
  btn.addEventListener('click', () => _triggerDismiss(toast.id));

  el.appendChild(icon);
  el.appendChild(msg);
  el.appendChild(btn);

  return el;
}

/**
 * Animate a toast element out then remove it from the DOM and internal state.
 * Total removal completes within ANIMATE_OUT_MS (300 ms) — Req 10.5.
 */
function _animateOut(id: string): void {
  const el = document.getElementById(`toast-${id}`);
  if (el) {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), ANIMATE_OUT_MS);
  }
  // Remove from internal stack immediately so queue logic is correct
  const idx = _stack.findIndex((t) => t.id === id);
  if (idx !== -1) _stack.splice(idx, 1);
  _timers.delete(id);
}

/**
 * Cancel any pending auto-dismiss timer and trigger the animated removal.
 */
function _triggerDismiss(id: string): void {
  const timer = _timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    _timers.delete(id);
  }
  _animateOut(id);
}

/**
 * Render the entire stack into #toast-stack.
 * index.html sets flex-direction:column-reverse so the last child (newest)
 * visually appears at the top of the stack — Req 10.4.
 */
function _render(): void {
  const container = getContainer();
  if (!container) return;

  // Remove DOM elements for toasts no longer in the stack
  const activeIds = new Set(_stack.map((t) => t.id));
  Array.from(container.children).forEach((child) => {
    const childId = child.id.replace('toast-', '');
    if (!activeIds.has(childId)) child.remove();
  });

  // Append elements for newly added toasts (those without a DOM node yet)
  for (const toast of _stack) {
    if (!document.getElementById(`toast-${toast.id}`)) {
      container.appendChild(_buildElement(toast));
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueues a toast notification.
 *
 * - Stack < 5: push and render (Req 10.4)
 * - Stack full + at least one success toast: evict oldest success, push (Req 10.6)
 * - Stack full with only persistent error toasts: reject silently (Req 10.6)
 *
 * Auto-dismisses success toasts after 4 seconds (Req 10.2).
 * Error toasts persist until user dismisses (Req 10.3).
 */
export function enqueueToast(toast: Toast): void {
  if (_stack.length >= MAX_TOASTS) {
    const oldestSuccessIdx = _stack.findIndex(
      (t) => t.type === 'success' && !t.persistent
    );
    if (oldestSuccessIdx !== -1) {
      const evicted = _stack[oldestSuccessIdx];
      _triggerDismiss(evicted.id);
    } else {
      // Only persistent error toasts remain — reject new toast (Req 10.6)
      return;
    }
  }

  _stack.push(toast);
  _render();

  // Schedule auto-dismiss for success toasts (Req 10.2)
  if (toast.type === 'success' && !toast.persistent) {
    const timer = setTimeout(() => _triggerDismiss(toast.id), SUCCESS_DISMISS_MS);
    _timers.set(toast.id, timer);
  }
}

/**
 * Programmatically dismiss a toast by id (within 300 ms — Req 10.5).
 */
export function dismissToast(id: string): void {
  _triggerDismiss(id);
}

/**
 * Returns a shallow copy of the current toast stack (oldest first).
 */
export function getToasts(): Toast[] {
  return [..._stack];
}

/**
 * Clears all toasts and cancels all timers (used in tests).
 */
export function clearToasts(): void {
  _timers.forEach((timer) => clearTimeout(timer));
  _timers.clear();
  _stack.length = 0;
  const container = getContainer();
  if (container) container.innerHTML = '';
}
