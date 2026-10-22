import { getDashboardBasePath } from "./dashboard-base-path";
import type { InboxDrafts } from "./inbox-drafts";

// The signed-in account's inbox draft scope. The admin shell clears it on sign-out,
// so it stays apart from the composer's draft logic (`inbox-drafts.ts`), which loads with the inbox.
export const draftKeyPrefix = () => `scalius:inbox-drafts:v1:${getDashboardBasePath()}:`;
export const cachedInboxDrafts = new Map<string, InboxDrafts>();
const listeners = new Set<() => void>();
let account: string | null = null;
let generation = 0;
let search = "";
export const emitInboxDrafts = () => listeners.forEach((listener) => listener());
export const inboxDraftAccount = () => account;
export const subscribeInboxDrafts = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const inboxDraftGeneration = () => generation;
export const getInboxSearch = (userId: string | null) => account === userId ? search : "";
export function setInboxSearch(userId: string | null, value: string) { if (!userId || account !== userId) return; search = value.slice(0, 100); emitInboxDrafts(); }

export function revokeInboxDraftPreviews(drafts: InboxDrafts) {
  for (const mode of ["public", "internal"] as const) {
    for (const image of drafts[mode].images) if (image.preview.startsWith("blob:")) URL.revokeObjectURL(image.preview);
  }
}

/** Same-tab confirmed sign-out and the existing cross-tab sign-out receiver call this. */
export function clearInboxDrafts() {
  generation++;
  account = null;
  search = "";
  cachedInboxDrafts.forEach(revokeInboxDraftPreviews);
  cachedInboxDrafts.clear();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(draftKeyPrefix())) sessionStorage.removeItem(key);
    }
  } catch { /* In-memory clearing must still happen when storage is unavailable. */ }
  emitInboxDrafts();
}

/** Called before mounting an account's composer; never keeps the previous account's drafts. */
export function activateInboxDraftAccount(next: string | null) {
  if (account === next) return;
  let previous: string | null = account;
  try { previous ??= sessionStorage.getItem(`${draftKeyPrefix()}account`); } catch { /* Memory still scopes by account. */ }
  if (previous && previous !== next) clearInboxDrafts();
  account = next;
  try {
    if (next) sessionStorage.setItem(`${draftKeyPrefix()}account`, next);
  } catch { /* Each draft reports its own persistence failure. */ }
}
