// The visitor id islands and pixels share (`context.visitorId()`, each pixel
// event's `context.visitorId`): a random id kept in this browser's storage
// for the store's origin, only while the buyer's consent allows analytics.
// Without that consent there is none (null), and withdrawing it forgets the
// stored one. Nothing on the server reads it, so a cached page stays the same
// for every buyer: an experiment picks its variant in the browser.

import { consentAllows } from "../tracking/consent";

const STORAGE_KEY = "scalius_visitor_id";
const VISITOR_ID = /^[0-9a-f]{32}$/;
let pageVisitor: string | null = null;

function storage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function newVisitorId(): string {
  const values = globalThis.crypto.getRandomValues(new Uint32Array(4));
  return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
}

function forget(): void {
  pageVisitor = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Blocked storage held nothing.
  }
}

/** The visitor id, made on first use; null while consent does not allow analytics. */
export function visitorId(): string | null {
  if (typeof window === "undefined") return null;
  if (!consentAllows("analytics")) {
    forget();
    return null;
  }
  if (pageVisitor) return pageVisitor;
  const store = storage();
  let stored: string | null = null;
  try {
    stored = store?.getItem(STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  pageVisitor = stored && VISITOR_ID.test(stored) ? stored : newVisitorId();
  if (pageVisitor !== stored) {
    try {
      store?.setItem(STORAGE_KEY, pageVisitor);
    } catch {
      // Blocked storage: the id lasts this page.
    }
  }
  return pageVisitor;
}

if (typeof window !== "undefined") {
  // A withdrawn choice forgets the id at once, not on the next read.
  window.addEventListener("scalius:consent", () => {
    if (!consentAllows("analytics")) forget();
  });
}
