// The storefront's render host for app components (packages/plugin-sdk/docs/storefront.md).
//
// A page asks for each component as Astro reaches it (the header, every card
// of a grid, each section, skin and slot component). The host joins every ask made in the same task
// into one batch per app, so a listing of 36 app cards is one call, not 36,
// and runs each batch with the app's module (loaders.ts). Every answer:
//
// - is checked (`sanitizePluginHtml`, component profile): markup and safe CSS pass, script runs
//   only as declared islands;
// - is kept in this isolate's memory by its full input, so the header,
//   footer and every card already drawn cost nothing on the next page
//   (and pages served from the page cache run no app code at all);
// - comes within `renderWallMs`, or the page draws without it: a section
//   or component draws nothing, a skin leaves its unit to core. This timeout cannot
//   preempt synchronous bundled code or detect incorrect layout/interaction.
//   A page drawn without an answer (late, failed, refused, or a release the
//   isolate cannot load) calls `degraded`, so the page cache never keeps it.

import {
  STOREFRONT_COMPONENT_ABI,
  STOREFRONT_COMPONENT_LIMITS,
  type StorefrontExtension,
  type StorefrontRenderContext,
  type StorefrontRenderJob,
  storefrontExtensionBase,
} from "@scalius/shared/plugins/storefront-components";
import { sanitizePluginHtml } from "@scalius/shared/plugins/html";
import { runStorefrontModule, type ExtensionRuntime } from "./loaders";

/** A job as a component asks for it (the host names it). */
export type ExtensionJob = StorefrontRenderJob extends infer Job ? Job extends unknown ? Omit<Job, "id"> : never : never;

interface Pending {
  job: StorefrontRenderJob;
  key: string;
  jsonLd: boolean;
  resolve: (html: string | null) => void;
}

// ── The isolate's memory of rendered components ───────────────────────────

const MEMO_MAX_ENTRIES = 2_000;
const MEMO_MAX_BYTES = 8 * 1024 * 1024;
const memo = new Map<string, string>();
let memoBytes = 0;

function remember(key: string, html: string): void {
  if (memo.has(key)) return;
  memo.set(key, html);
  memoBytes += key.length + html.length;
  // Oldest first: Map keeps insertion order.
  while (memo.size > MEMO_MAX_ENTRIES || memoBytes > MEMO_MAX_BYTES) {
    const oldest = memo.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    memoBytes -= oldest.length + (memo.get(oldest)?.length ?? 0);
    memo.delete(oldest);
  }
}

function recall(key: string): string | undefined {
  const html = memo.get(key);
  if (html === undefined) return undefined;
  // Refresh its place: a component every page draws stays.
  memo.delete(key);
  memo.set(key, html);
  return html;
}

/** Test seam. */
export function clearExtensionMemo(): void {
  memo.clear();
  memoBytes = 0;
}

// ── Logging (bounded: a broken component must not flood the logs) ─────────

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key) || warned.size > 200) return;
  warned.add(key);
  console.warn(`[Storefront components] ${message}`);
}

// ── The host ──────────────────────────────────────────────────────────────

export interface ExtensionHostOptions {
  runtime: ExtensionRuntime;
  context: StorefrontRenderContext;
  /** Test seam: the module runner. */
  run?: typeof runStorefrontModule;
  /** Test seam: the wall time of one batch. */
  wallMs?: number;
  /** Whether component JSON-LD may stay (not on a `noindex` page); asked at each render. */
  jsonLd?: () => boolean;
  /** Called when a component the page asked for draws its fallback instead (the page must not be stored). */
  degraded?: () => void;
}

export class ExtensionHost {
  readonly #options: ExtensionHostOptions;
  readonly #queues = new Map<string, { extension: StorefrontExtension; pending: Pending[] }>();
  #scheduled = false;
  #next = 0;

  constructor(options: ExtensionHostOptions) {
    this.#options = options;
  }

  get context(): StorefrontRenderContext {
    return this.#options.context;
  }

  /** The render context one app gets (its own file base). */
  contextOf(extension: StorefrontExtension): StorefrontRenderContext {
    return { ...this.#options.context, assets: storefrontExtensionBase(extension.pluginId, extension.release) };
  }

  /**
   * The component's checked markup, or null when it draws nothing, fails or
   * is late. `jsonLd: false` strips its JSON-LD (core owns the page's
   * structured data there), as a `noindex` page always does.
   */
  render(extension: StorefrontExtension, ask: ExtensionJob, options: { jsonLd?: boolean } = {}): Promise<string | null> {
    const context = this.#options.context;
    const jsonLd = (options.jsonLd ?? true) && (this.#options.jsonLd?.() ?? true);
    const key = `${extension.pluginId}\u0000${extension.release}\u0000${jsonLd}\u0000${JSON.stringify(context)}\u0000${JSON.stringify(ask)}`;
    const known = recall(key);
    if (known !== undefined) return Promise.resolve(known);
    const job = { ...ask, id: `j${this.#next++}` } as StorefrontRenderJob;
    return new Promise((resolve) => {
      const queue = this.#queues.get(extension.pluginId) ?? { extension, pending: [] };
      queue.pending.push({ job, key, jsonLd, resolve });
      this.#queues.set(extension.pluginId, queue);
      if (!this.#scheduled) {
        this.#scheduled = true;
        // After this task: every component Astro starts meanwhile joins the batch.
        setTimeout(() => this.#flush(), 0);
      }
    });
  }

  #flush(): void {
    this.#scheduled = false;
    const queues = [...this.#queues.values()];
    this.#queues.clear();
    for (const { extension, pending } of queues) {
      for (let start = 0; start < pending.length; start += STOREFRONT_COMPONENT_LIMITS.batchJobs) {
        void this.#runBatch(extension, pending.slice(start, start + STOREFRONT_COMPONENT_LIMITS.batchJobs));
      }
    }
  }

  async #runBatch(extension: StorefrontExtension, pending: Pending[]): Promise<void> {
    const run = this.#options.run ?? runStorefrontModule;
    const wallMs = this.#options.wallMs ?? STOREFRONT_COMPONENT_LIMITS.renderWallMs;
    const fallBack = (entry: Pending, key: string, message: string) => {
      warnOnce(key, message);
      this.#options.degraded?.();
      entry.resolve(null);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        run(this.#options.runtime, extension, { abi: STOREFRONT_COMPONENT_ABI, context: this.contextOf(extension), jobs: pending.map((entry) => entry.job) }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${wallMs} ms`)), wallMs);
        }),
      ]);
      const results = new Map(reply.results.map((result) => [result.id, result]));
      for (const entry of pending) {
        const result = results.get(entry.job.id);
        if (!result || "error" in result) {
          fallBack(entry, `${extension.pluginId}:${describe(entry.job)}`, `${extension.pluginId} ${describe(entry.job)}: ${result && "error" in result ? result.error : "no result"}`);
          continue;
        }
        // An app page's forms post only to the app's own routes.
        const page = entry.job.kind === "component" && entry.job.target === "page";
        const checked = sanitizePluginHtml(result.html, { pluginId: extension.pluginId, jsonLd: entry.jsonLd, ...(page ? { formsTo: `/apps/${extension.pluginId}/` } : {}) });
        if (!checked.ok) {
          fallBack(entry, `${extension.pluginId}:size:${describe(entry.job)}`, `${extension.pluginId} ${describe(entry.job)} drew markup over its bounds (${checked.reason}).`);
          continue;
        }
        remember(entry.key, checked.html);
        entry.resolve(checked.html);
      }
    } catch (error) {
      const message = `${extension.pluginId}: ${error instanceof Error ? error.message : String(error)}; the page draws without it.`;
      for (const entry of pending) fallBack(entry, `${extension.pluginId}:batch`, message);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function describe(job: StorefrontRenderJob): string {
  if (job.kind === "section") return `section ${job.type}`;
  if (job.kind === "component") return `component ${job.type} at ${job.target}`;
  return `${job.target} skin ${job.component}`;
}
