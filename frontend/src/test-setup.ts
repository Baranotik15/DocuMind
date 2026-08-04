import { afterEach } from 'vitest'

import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// The project's vitest config doesn't enable RTL's implicit `globals`-based
// auto cleanup, so without this, DOM from one test in a multi-`it` file
// leaks into the next (duplicate seeded content, stale event handlers).
afterEach(() => {
  cleanup()
})

// jsdom doesn't implement matchMedia; Mantine's MantineProvider reads it
// to detect the OS color scheme.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})

// jsdom doesn't implement ResizeObserver; Mantine's Select/Combobox dropdown
// (its internal ScrollArea) reads it to track scrollbar size.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  value: ResizeObserverStub,
})

// jsdom doesn't implement the FontFaceSet API; Mantine's autosizing Textarea
// (used for chunk editing in ChunkPreviewPage.tsx) listens for
// `document.fonts`'s "loadingdone" event to recalculate its height once web
// fonts finish loading.
Object.defineProperty(document, 'fonts', {
  writable: true,
  value: {
    addEventListener: () => {},
    removeEventListener: () => {},
  },
})
