/**
 * Vitest setup for the `ui` project (jsdom): jest-dom matchers, cleanup, and the browser APIs
 * jsdom lacks that React Flow and the components use.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

import { setClock } from '../lib/clock.js';
import { TEST_NOW } from './constants.js';

// Relative times ("42 min ago") are computed against the fixtures' fixed now.
setClock(() => TEST_NOW);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

class ResizeObserverStub {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element): void {
    this.cb([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this);
  }
  unobserve(): void {
    // Nothing to release in the stub.
  }
  disconnect(): void {
    // Nothing to release in the stub.
  }
}
globalThis.ResizeObserver = ResizeObserverStub;

class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform?: string) {
    const scale = /scale\(([\d.]+)\)/.exec(transform ?? '')?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
}
(globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly ??= DOMMatrixReadOnlyStub;

// React Flow measures nodes through offsetWidth/offsetHeight; give every element a size.
Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: { configurable: true, get: () => 60 },
  offsetWidth: { configurable: true, get: () => 200 },
});
(SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
  ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;

window.matchMedia = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => false,
});

window.scrollTo = () => undefined;
