// A create form's unsaved values, kept on this device so a reload, a closed
// tab or a crash doesn't lose them (`useCreateDraft`). One entry per create
// form and staff member, for a day; taken off when the record is created or
// the merchant discards the draft, and every one goes at sign-out. Secret
// fields never reach storage.
import { getDashboardBasePath } from "./dashboard-base-path";

const PREFIX = "scalius.createDraft:";
/** How long a draft is offered back. */
export const CREATE_DRAFT_LIFETIME_MS = 24 * 60 * 60 * 1000;

let account: string | null = null;

/** The signed-in staff member (the admin shell sets it while rendering, before any form mounts). */
export function setCreateDraftAccount(userId: string | null): void {
  account = userId;
}

export interface StoredDraft<T = unknown> {
  savedAt: number;
  values: T;
}

/** The storage key of one create form (its address) for the signed-in staff member; null signed out. */
export function createDraftKey(form: string): string | null {
  return account ? `${PREFIX}${getDashboardBasePath()}:${account}:${form}` : null;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readCreateDraft<T>(key: string, now = Date.now()): StoredDraft<T> | null {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft<T>;
    if (typeof parsed?.savedAt !== "number" || now - parsed.savedAt > CREATE_DRAFT_LIFETIME_MS) {
      storage()?.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Writes the draft; answers what it wrote (the values' JSON), so a caller skips unchanged writes. */
export function writeCreateDraft(key: string, json: string, now = Date.now()): void {
  try {
    storage()?.setItem(key, `{"savedAt":${now},"values":${json}}`);
  } catch {
    // Storage full or blocked: the leave warning still protects the page.
  }
}

export function removeCreateDraft(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to remove.
  }
}

/** Every create draft on this device (sign-out, so the next person finds none). */
export function clearCreateDrafts(): void {
  const store = storage();
  if (!store) return;
  try {
    for (const key of Object.keys(store)) if (key.startsWith(PREFIX)) store.removeItem(key);
  } catch {
    // Storage blocked.
  }
}

/** Fields whose names say they hold a secret: never kept, whatever the form. */
const SECRET_NAME = /pass(word|code|phrase)|secret|token|api[-_]?key|private[-_]?key|credential|signing[-_]?key|(^|[-_.])otp($|[-_.])/i;

/** The names of the secret inputs on screen: password and one-time-code fields, by their type. */
export function secretInputNames(root: ParentNode | null = typeof document === "undefined" ? null : document): Set<string> {
  const names = new Set<string>();
  if (!root) return names;
  const secretAutocomplete = new Set(["one-time-code", "new-password", "current-password"]);
  for (const input of root.querySelectorAll<HTMLInputElement>("input[name]")) {
    if (input.type === "password" || secretAutocomplete.has(input.autocomplete)) names.add(input.name);
  }
  return names;
}

/**
 * The values as kept: plain data only (no files or functions), without any
 * field that is a secret by its input type or its name. `path` is the
 * react-hook-form name ("rates.0.fee").
 */
export function draftableValues(value: unknown, secrets: ReadonlySet<string> = new Set(), path = ""): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item, index) => draftableValues(item, secrets, path ? `${path}.${index}` : String(index)));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const name = path ? `${path}.${key}` : key;
    if (SECRET_NAME.test(key) || secrets.has(name)) continue;
    const next = draftableValues(item, secrets, name);
    if (next !== undefined) kept[key] = next;
  }
  return kept;
}
