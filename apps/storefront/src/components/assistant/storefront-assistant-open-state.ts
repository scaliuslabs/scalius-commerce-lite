export const STOREFRONT_ASSISTANT_OPEN_STATE_STORAGE_KEY =
  "scalius.storefront-assistant.panel-open.v1";

type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserSessionStorage(): SessionStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStorefrontAssistantOpenState(
  storage: SessionStorage | null = browserSessionStorage(),
): boolean {
  if (!storage) return false;
  try {
    return (
      storage.getItem(STOREFRONT_ASSISTANT_OPEN_STATE_STORAGE_KEY) === "open"
    );
  } catch {
    return false;
  }
}

export function writeStorefrontAssistantOpenState(
  open: boolean,
  storage: SessionStorage | null = browserSessionStorage(),
): boolean {
  if (!storage) return false;
  try {
    if (open) {
      storage.setItem(STOREFRONT_ASSISTANT_OPEN_STATE_STORAGE_KEY, "open");
    } else {
      storage.removeItem(STOREFRONT_ASSISTANT_OPEN_STATE_STORAGE_KEY);
    }
    return true;
  } catch {
    return false;
  }
}
