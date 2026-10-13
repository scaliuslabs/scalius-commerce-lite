import type { ConversationProductReference, ConversationProductSnapshot } from "@scalius/shared/conversation";
import { getDashboardBasePath } from "./dashboard-base-path";

export type DraftMode = "public" | "internal";
export interface DraftImage {
  attachmentId: string;
  conversationId: string;
  width: number | null;
  height: number | null;
  name: string;
  preview: string;
}
export interface DraftPayload { body: string; visibility: DraftMode; attachmentIds?: string[]; products?: ConversationProductReference[] }
export interface DraftAttempt { key: string; payload: DraftPayload }
/** Compare send meaning, not object insertion order after JSON storage normalization. */
export function sameDraftPayload(left: DraftPayload, right: DraftPayload): boolean {
  const canonical = (payload: DraftPayload) => JSON.stringify([payload.body, payload.visibility, payload.attachmentIds ?? [], (payload.products ?? []).map(({ productId, skuId }) => [productId, skuId])]);
  return canonical(left) === canonical(right);
}
export interface MessageDraft {
  body: string;
  images: DraftImage[];
  products: ConversationProductSnapshot[];
  uploading: number;
  omittedImages: number;
  retryImages: boolean;
  attempt: DraftAttempt | null;
  error: string | null;
}
export interface InboxDrafts { public: MessageDraft; internal: MessageDraft; storageFailed: boolean }
const MAX_BODY = 5_000;
const MAX_ENTRIES = 20;
const TTL = 24 * 60 * 60_000;
const emptyDraft = (): MessageDraft => ({ body: "", images: [], products: [], uploading: 0, omittedImages: 0, retryImages: false, attempt: null, error: null });
const emptyDrafts = (): InboxDrafts => ({ public: emptyDraft(), internal: emptyDraft(), storageFailed: false });
const prefix = () => `scalius:inbox-drafts:v1:${getDashboardBasePath()}:`;
const scopeKey = (account: string, owner: string) => `${prefix()}${encodeURIComponent(account)}:${encodeURIComponent(owner)}`;
const cached = new Map<string, InboxDrafts>();
const listeners = new Set<() => void>();
let account: string | null = null;
let generation = 0;
let search = "";
const emit = () => listeners.forEach((listener) => listener());
export const subscribeInboxDrafts = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const inboxDraftGeneration = () => generation;
export const getInboxSearch = (userId: string | null) => account === userId ? search : "";
export function setInboxSearch(userId: string | null, value: string) { if (!userId || account !== userId) return; search = value.slice(0, 100); emit(); }

function revoke(drafts: InboxDrafts) {
  for (const mode of ["public", "internal"] as const) {
    for (const image of drafts[mode].images) if (image.preview.startsWith("blob:")) URL.revokeObjectURL(image.preview);
  }
}

/** Same-tab confirmed sign-out and the existing cross-tab sign-out receiver call this. */
export function clearInboxDrafts() {
  generation++;
  account = null;
  search = "";
  cached.forEach(revoke);
  cached.clear();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(prefix())) sessionStorage.removeItem(key);
    }
  } catch { /* In-memory clearing must still happen when storage is unavailable. */ }
  emit();
}

/** Called before mounting an account's composer; never keeps the previous account's drafts. */
export function activateInboxDraftAccount(next: string | null) {
  if (account === next) return;
  let previous: string | null = account;
  try { previous ??= sessionStorage.getItem(`${prefix()}account`); } catch { /* Memory still scopes by account. */ }
  if (previous && previous !== next) clearInboxDrafts();
  account = next;
  try {
    if (next) sessionStorage.setItem(`${prefix()}account`, next);
  } catch { /* Each draft reports its own persistence failure. */ }
}

function attempt(value: unknown, mode: DraftMode): DraftAttempt | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<DraftAttempt>;
  const p = v.payload;
  if (typeof v.key !== "string" || v.key.length > 100 || !v.key || !p
    || typeof p.body !== "string" || p.body.length > MAX_BODY || p.visibility !== mode
    || (p.attachmentIds !== undefined && (!Array.isArray(p.attachmentIds) || p.attachmentIds.length > 3
      || p.attachmentIds.some((id) => typeof id !== "string" || !id || id.length > 100)))) return null;
  if (p.products !== undefined && (!Array.isArray(p.products) || p.products.length > 3 || p.products.some((product) => !product || typeof product.productId !== "string" || typeof product.skuId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(product.productId) || !/^[A-Za-z0-9_-]{1,128}$/.test(product.skuId)))) return null;
  return { key: v.key, payload: { body: p.body, visibility: mode, ...(p.attachmentIds?.length ? { attachmentIds: p.attachmentIds } : {}), ...(p.products?.length ? { products: p.products } : {}) } };
}

export function getInboxDrafts(userId: string, owner: string): InboxDrafts {
  const key = scopeKey(userId, owner);
  const existing = cached.get(key);
  if (existing) return existing;
  const result = emptyDrafts();
  try {
    const raw = sessionStorage.getItem(key);
    if (raw && raw.length < 80_000) {
      const saved = JSON.parse(raw);
      if (typeof saved.updatedAt === "number" && saved.updatedAt > Date.now() - TTL && saved.updatedAt <= Date.now()) {
        for (const mode of ["public", "internal"] as const) {
          const row = saved[mode];
          if (!row || typeof row.body !== "string" || row.body.length > MAX_BODY) continue;
          result[mode].body = row.body;
          if (mode === "public" && Array.isArray(row.products)) result[mode].products = row.products.slice(0, 3).filter((product: ConversationProductSnapshot) => product && typeof product.productId === "string" && typeof product.skuId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(product.productId) && /^[A-Za-z0-9_-]{1,128}$/.test(product.skuId) && typeof product.title === "string" && product.title.length <= 1000 && (product.variantLabel === null || typeof product.variantLabel === "string" && product.variantLabel.length <= 1000));
          result[mode].attempt = attempt(row.attempt, mode);
          result[mode].retryImages = row.retry === true && Boolean(result[mode].attempt?.payload.attachmentIds?.length);
          result[mode].omittedImages = Number.isInteger(row.imageCount) ? Math.min(3, Math.max(0, row.imageCount)) : 0;
        }
      }
    }
  } catch { result.storageFailed = true; }
  cached.set(key, result);
  if (cached.size > MAX_ENTRIES * 2) {
    const oldest = cached.keys().next().value;
    if (oldest && oldest !== key) { const old = cached.get(oldest); if (old) revoke(old); cached.delete(oldest); }
  }
  return result;
}

function persist(key: string, value: InboxDrafts): boolean {
  try {
    const row = (draft: MessageDraft) => ({ body: draft.body, products: draft.products, imageCount: Math.min(3, draft.images.length + draft.uploading + draft.omittedImages), attempt: draft.attempt,
      retry: draft.images.length ? JSON.stringify(draft.images.map((image) => image.attachmentId)) === JSON.stringify(draft.attempt?.payload.attachmentIds ?? []) : draft.retryImages });
    if (value.public.body.length > MAX_BODY || value.internal.body.length > MAX_BODY) return false;
    const hasContent = [value.public, value.internal].some((draft) => draft.body || draft.products.length || draft.images.length || draft.uploading || draft.omittedImages || draft.attempt);
    if (hasContent) sessionStorage.setItem(key, JSON.stringify({ updatedAt: Date.now(), public: row(value.public), internal: row(value.internal) }));
    else sessionStorage.removeItem(key);
    const entries: Array<{ key: string; time: number }> = [];
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const candidate = sessionStorage.key(i)!;
      if (!candidate.startsWith(prefix()) || candidate === `${prefix()}account`) continue;
      let time = 0;
      try { time = JSON.parse(sessionStorage.getItem(candidate) ?? "null")?.updatedAt ?? 0; } catch { /* Remove corrupt entries. */ }
      if (time < Date.now() - TTL) sessionStorage.removeItem(candidate);
      else entries.push({ key: candidate, time });
    }
    for (const entry of entries.sort((a, b) => b.time - a.time).slice(MAX_ENTRIES)) {
      sessionStorage.removeItem(entry.key);
      const stale = cached.get(entry.key);
      if (stale) revoke(stale);
      cached.delete(entry.key);
    }
    return true;
  } catch { return false; }
}

export function updateInboxDraft(
  userId: string, owner: string, mode: DraftMode,
  update: (draft: MessageDraft) => MessageDraft,
  expectedGeneration = generation,
) {
  if (account !== userId || expectedGeneration !== generation) return;
  const key = scopeKey(userId, owner);
  const current = getInboxDrafts(userId, owner);
  const next = { ...current, [mode]: update(current[mode]) };
  next.storageFailed = !persist(key, next);
  cached.set(key, next);
  emit();
}

/** Settle the submitted owner/mode even after its React composer unmounted. */
export function completeInboxDraft(userId: string, owner: string, mode: DraftMode, sent: DraftAttempt, epoch: number) {
  updateInboxDraft(userId, owner, mode, (draft) => {
    const ids = new Set(sent.payload.attachmentIds);
    const images = draft.images.filter((image) => {
      if (!ids.has(image.attachmentId)) return true;
      if (image.preview.startsWith("blob:")) URL.revokeObjectURL(image.preview);
      return false;
    });
    const sentProducts = new Set(sent.payload.products?.map((product) => product.skuId));
    return { ...draft, images, products: draft.products.filter((product) => !sentProducts.has(product.skuId)), body: draft.body === sent.payload.body ? "" : draft.body,
      omittedImages: draft.body === sent.payload.body ? 0 : draft.omittedImages,
      retryImages: draft.attempt?.key === sent.key ? false : draft.retryImages,
      attempt: draft.attempt?.key === sent.key ? null : draft.attempt, error: null };
  }, epoch);
}
