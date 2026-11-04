import { BUILD_ID } from "@/config/build-id";
import { STALE_ASSET_EVENT } from "@/scripts/browser-events";

/** How `loadLazyScript` judges a failure (tests replace the store's answers). */
export interface LazyScriptOptions {
  /** Whether a reload would lose what the buyer typed (default: any changed field on the page). */
  typed?: () => boolean;
  /** The build the store serves now, or null when it cannot say. */
  servedBuild?: () => Promise<string | null>;
  /** This page's build. */
  pageBuild?: string;
}

/** Whether the buyer has typed or chosen something on the page that a reload would lose. */
export function pageHasTypedInput(root: ParentNode = document): boolean {
  for (const field of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")) {
    if (field instanceof HTMLSelectElement) {
      const options = Array.from(field.options);
      if (options.length === 0) continue;
      if (field.multiple) {
        if (options.some((option) => option.selected !== option.defaultSelected)) return true;
        continue;
      }
      // A one-choice list opens on its last option marked selected, else its first.
      let drawn = 0;
      options.forEach((option, index) => {
        if (option.defaultSelected) drawn = index;
      });
      if (field.selectedIndex !== drawn) return true;
      continue;
    }
    if (field instanceof HTMLInputElement) {
      if (["hidden", "submit", "button", "reset", "image"].includes(field.type)) continue;
      if (field.type === "checkbox" || field.type === "radio") {
        if (field.checked !== field.defaultChecked) return true;
        continue;
      }
    }
    if (field.value !== field.defaultValue) return true;
  }
  return false;
}

/** The build the store serves now (its health answer, never cached), or null when it cannot say. */
export async function storeServedBuild(): Promise<string | null> {
  try {
    const response = await fetch("/health", { cache: "no-store", credentials: "omit" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const buildId = typeof body === "object" && body !== null ? (body as { buildId?: unknown }).buildId : null;
    return typeof buildId === "string" && buildId ? buildId : null;
  } catch {
    return null;
  }
}

/**
 * One of the store's lazy scripts (a flyout, a palette, a form's helper),
 * with the failure handling they all share: a script the page asks for later
 * can fail to download, and that part of the page must not stay dead.
 *
 * - When the store now serves another build (`/health`), the page was cached
 *   before a deploy and its build files are gone: the page's stale-asset
 *   recovery (lib/inline-boot-scripts.ts) reloads it, unless the buyer typed
 *   or chose something on it that a reload would lose.
 * - Otherwise (the same build, or the store cannot say: a dropped
 *   connection) it is tried once more.
 *
 * The promise still rejects when that fails too, so the caller forgets the
 * attempt and a later reach for the part tries again; a caller with nothing
 * to fall back to catches it.
 */
export async function loadLazyScript<T>(load: () => Promise<T>, options: LazyScriptOptions = {}): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const served = await (options.servedBuild ?? storeServedBuild)();
    if (served !== null && served !== (options.pageBuild ?? BUILD_ID)) {
      if (!(options.typed ?? pageHasTypedInput)()) window.dispatchEvent(new Event(STALE_ASSET_EVENT));
      throw error;
    }
    return await load();
  }
}
