// Mock localStorage
const store = new Map()
const localStorageMock = {
  get length() { return store.size },
  key: (index) => [...store.keys()][index] ?? null,
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
}
Object.defineProperty(window, 'localStorage', { value: localStorageMock })

// Mock navigator.language
Object.defineProperty(window.navigator, 'language', { value: 'es', configurable: true })
