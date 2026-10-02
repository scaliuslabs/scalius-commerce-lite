// The location a scanner counts and adjusts stock at (commerce hook H1).
// Remembered per device, since a phone usually lives at one shop or
// warehouse. Storage may be missing or throw (private mode, blocked site
// data): the choice then lasts the session and the default location is the
// fallback, so nothing ever depends on storage working.

export const SCANNER_LOCATION_STORAGE_KEY = "scalius.scanner.location";

export interface ScannerLocation {
  id: string;
  name: string;
  isDefault: boolean;
}

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

function deviceStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readRememberedScannerLocation(storage: ReadableStorage | null = deviceStorage()): string | null {
  try {
    return storage?.getItem(SCANNER_LOCATION_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function rememberScannerLocation(id: string, storage: WritableStorage | null = deviceStorage()): void {
  try {
    storage?.setItem(SCANNER_LOCATION_STORAGE_KEY, id);
  } catch {
    // Not remembered on this device; the choice still holds for this session.
  }
}

/** The remembered location while it is still active, else the default, else the first. */
export function pickScannerLocation(
  active: readonly ScannerLocation[],
  remembered: string | null,
): ScannerLocation | null {
  return active.find((location) => location.id === remembered)
    ?? active.find((location) => location.isDefault)
    ?? active[0]
    ?? null;
}
