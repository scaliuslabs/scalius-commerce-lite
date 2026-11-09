// Whose create drafts are on this device: the admin shell names the signed-in
// staff member while rendering, and sign-out clears every draft. Apart from
// the draft store (./create-drafts) so the shell, which every screen loads,
// does not carry the form side.
import { getDashboardBasePath } from "./dashboard-base-path";

export const CREATE_DRAFT_PREFIX = "scalius.createDraft:";

let account: string | null = null;

/** The signed-in staff member (the admin shell sets it while rendering, before any form mounts). */
export function setCreateDraftAccount(userId: string | null): void {
  account = userId;
}

/** The storage key of one create form (its address) for the signed-in staff member; null signed out. */
export function createDraftKey(form: string): string | null {
  return account ? `${CREATE_DRAFT_PREFIX}${getDashboardBasePath()}:${account}:${form}` : null;
}

export function createDraftStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Every create draft on this device (sign-out, so the next person finds none). */
export function clearCreateDrafts(): void {
  const store = createDraftStorage();
  if (!store) return;
  try {
    for (const key of Object.keys(store)) if (key.startsWith(CREATE_DRAFT_PREFIX)) store.removeItem(key);
  } catch {
    // Storage blocked.
  }
}
