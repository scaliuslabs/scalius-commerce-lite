import { CACHE_COMMIT_SEQ_HEADER } from "@scalius/shared/cache-frontier";

/**
 * The newest store change clock this tab has seen on a write response
 * (`X-Scalius-Commit-Seq`, CACHE-DESIGN §6.10). "View on store" links carry
 * it as `_sv`, so the storefront validates its cached page against a change
 * frontier at least that new and the merchant sees their own save at once.
 * Per tab and in memory only: it is a freshness hint, not state.
 */
let latest: number | null = null;
const listeners = new Set<() => void>();

export function noteStoreCommitSeq(headers: Headers): void {
  const raw = headers.get(CACHE_COMMIT_SEQ_HEADER);
  if (raw === null || !/^\d{1,15}$/.test(raw)) return;
  const seq = Number(raw);
  if (latest !== null && seq <= latest) return;
  latest = seq;
  for (const listener of listeners) listener();
}

export function subscribeStoreCommitSeq(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readStoreCommitSeq(): number | null {
  return latest;
}
