import '@testing-library/jest-dom/vitest'

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
