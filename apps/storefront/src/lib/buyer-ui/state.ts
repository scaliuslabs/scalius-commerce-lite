import { checkoutAttributesSchema } from "@scalius/shared/plugins/buyer-ui";

const STORAGE_KEY = "scalius:buyer-attributes";

/** Buyer inputs live in the tab and request bodies, never in URLs or analytics. */
export function readBuyerAttributes(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 8192) return {};
    const parsed = checkoutAttributesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch { return {}; }
}

export function writeBuyerAttribute(key: string, value: string): boolean {
  const parsed = checkoutAttributesSchema.safeParse({ ...readBuyerAttributes(), [key]: value });
  if (!parsed.success) return false;
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(parsed.data)); return true; }
  catch { return false; }
}

export function clearBuyerAttributes(): void {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
}
