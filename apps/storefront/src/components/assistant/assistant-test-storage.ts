export function installMemoryBrowserStorage(): void {
  Object.defineProperties(window, {
    localStorage: {
      configurable: true,
      value: createMemoryStorage(),
    },
    sessionStorage: {
      configurable: true,
      value: createMemoryStorage(),
    },
  });
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } satisfies Storage;
}
