import { BUILD_ID } from "@/config/build-id";
import { STALE_ASSET_EVENT } from "@/scripts/browser-events";
import { stalePageCopy } from "@/lib/stale-page-copy";

/** How `loadLazyScript` judges a failure (tests replace the store's answers and the wait). */
export interface LazyScriptOptions {
  /** Whether a reload would lose what the buyer typed (default: `buyerHasTyped`). */
  typed?: () => boolean;
  /** The build the store serves now, or null when it cannot say. */
  servedBuild?: () => Promise<string | null>;
  /** This page's build. */
  pageBuild?: string;
  /** The wait before the second try, in milliseconds. */
  retryDelayMs?: number;
  /** The page keeps what the buyer typed across a reload (the checkout's draft): the notice says so. */
  draftRestores?: boolean;
  /**
   * The buyer needs the part to go on (the default): when it cannot load on a
   * newer build, the page offers its reload. An extra the page reads the
   * same without (desktop zoom, address suggestions) never asks for one.
   */
  needed?: boolean;
}

/** The wait before trying a failed download again: long enough for a dropped connection to come back. */
const RETRY_DELAY_MS = 800;
/** How long a stale page waits for the stale-asset recovery's reload before offering its own notice. */
const STALE_NOTICE_FALLBACK_MS = 2000;

const tracked = new WeakSet<Document>();
const typed = new WeakSet<Document>();

function isField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

/**
 * Notes the buyer's first input or choice on the page: any field's `input`
 * or `change`, heard on the document in the capture phase before a component
 * handles it. Values cannot tell instead: React keeps a controlled field's
 * text in its `defaultValue` too, so a typed field looks untouched.
 */
export function trackBuyerInput(doc: Document = document): void {
  if (tracked.has(doc)) return;
  tracked.add(doc);
  const mark = (event: Event) => {
    if (isField(event.target)) typed.add(doc);
  };
  doc.addEventListener("input", mark, true);
  doc.addEventListener("change", mark, true);
}

/** Whether the buyer has typed or chosen something on the page that a reload would lose. */
export function buyerHasTyped(doc: Document = document): boolean {
  return typed.has(doc);
}

/** The page has started to leave (a reload under way): no notice may flash before it goes. */
let leaving = false;

// Every page that can load a lazy script notes typing from the start, and when it leaves.
if (typeof document !== "undefined") {
  trackBuyerInput();
  window.addEventListener("beforeunload", () => { leaving = true; });
  window.addEventListener("pageshow", () => { leaving = false; });
}

/** The wait between adding the notice's empty status region and its words, so screen readers announce them. */
const ANNOUNCE_DELAY_MS = 100;

/**
 * The notice a page shows when the store was updated after it loaded, the
 * part the buyer reached for cannot load, and a reload would lose what they
 * typed: they choose when to reload, or dismiss it. One per page; it never
 * takes focus. Its status region is in the page before its words arrive, so
 * a screen reader announces them; it sits just below the sticky header,
 * clear of every bottom action bar (theme-foundation.css).
 */
export function showStalePageNotice(options: { draftRestores?: boolean } = {}, doc: Document = document): void {
  if (doc.querySelector("[data-stale-page-notice]")) return;
  const copy = stalePageCopy(doc.documentElement.lang);
  const notice = doc.createElement("div");
  notice.setAttribute("data-stale-page-notice", "");
  notice.className = "fixed inset-x-3 z-[80] mx-auto flex max-w-md flex-wrap items-center gap-3 rounded-lg border border-border bg-background p-3 text-sm text-foreground shadow-lg";
  const status = doc.createElement("div");
  status.setAttribute("role", "status");
  status.className = "min-w-0 flex-1";
  const reload = doc.createElement("button");
  reload.type = "button";
  reload.className = "min-h-11 shrink-0 rounded-[var(--theme-button-radius,var(--radius))] bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
  reload.textContent = copy.reload;
  reload.addEventListener("click", () => doc.defaultView?.location.reload());
  const dismiss = doc.createElement("button");
  dismiss.type = "button";
  dismiss.className = "min-h-11 shrink-0 rounded-[var(--theme-button-radius,var(--radius))] px-3 font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
  dismiss.textContent = copy.dismiss;
  dismiss.addEventListener("click", () => notice.remove());
  notice.append(status, reload, dismiss);
  doc.body.append(notice);
  // The region first, its words a moment later: a region added with its text already in it is often not read.
  setTimeout(() => {
    const updated = doc.createElement("p");
    updated.textContent = copy.updated;
    status.append(updated);
    if (options.draftRestores) {
      const kept = doc.createElement("p");
      kept.className = "text-muted-foreground";
      kept.textContent = copy.draftKept;
      status.append(kept);
    }
  }, ANNOUNCE_DELAY_MS);
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
 *   before a deploy and its build files are gone, so no retry can work: the
 *   page's stale-asset recovery (lib/inline-boot-scripts.ts) reloads it, or,
 *   when the buyer has typed or chosen something a reload would lose, a
 *   notice lets them reload when they choose (saying so where the checkout's
 *   draft keeps their details).
 * - Otherwise (the same build, or the store cannot say: a dropped
 *   connection) it is tried once more after a short wait. The retry is the
 *   same request: the bundler resolves each lazy import to its hashed file
 *   at build time, so the page cannot ask for that file under another
 *   address (a query would also make a second copy of a module that holds
 *   state, such as the cart). A browser that remembers the failed file fails
 *   the retry at once; the next reach asks for the build again.
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
      if (options.needed === false) throw error;
      const notice = () => showStalePageNotice({ draftRestores: options.draftRestores });
      if ((options.typed ?? buyerHasTyped)()) notice();
      else {
        window.dispatchEvent(new Event(STALE_ASSET_EVENT));
        // The recovery reloads at most every 30 s: a page it did not reload offers the notice instead,
        // never one that is already leaving (a slow reload under way).
        setTimeout(() => {
          if (!leaving) notice();
        }, STALE_NOTICE_FALLBACK_MS);
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? RETRY_DELAY_MS));
    return await load();
  }
}
