// Opening the saved theme draft (or one published version) on the real
// storefront in a new tab, and the checks that keep that handoff safe.
import {
  getApiV1Platform,
  postApiV1AdminSettingsThemePreviewSession,
} from "@scalius/api-client/sdk";
import { presenceOfPath, stripPresencePath } from "@scalius/shared/markets";
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import { apiData } from "~/lib/api";

type Device = "full" | "desktop" | "mobile";

const PRIVATE_PATHS = new Set([
  ".well-known", "404", "500", "account", "api", "buy", "cart",
  "checkout", "health", "order-success", "payment-recovery", "robots.txt",
  "search", "theme-preview", "track-order", "ucp",
]);

function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (character === "\\" || (code !== undefined && (code <= 31 || code === 127))) return true;
  }
  return false;
}

/** A public storefront route, with no external origin, fragment or path normalization. */
export function isSafeThemePreviewPath(value: string): boolean {
  if (
    !value || value.length > 512 || !value.startsWith("/") ||
    value.startsWith("//") || hasUnsafeCharacter(value)
  ) return false;
  try {
    const parsed = new URL(value, "https://theme-preview.invalid");
    if (parsed.origin !== "https://theme-preview.invalid" || parsed.hash) return false;
    if (`${parsed.pathname}${parsed.search}` !== value) return false;
    // A market presence's page (`/en-in/products/x`): the page under its subfolder.
    const presence = presenceOfPath(parsed.pathname);
    const page = presence ? stripPresencePath(parsed.pathname, presence) : parsed.pathname;
    if (presence && page === parsed.pathname) return false;
    const segments = page.split("/").filter(Boolean);
    // The cart is a page template the editor previews.
    if (segments.length === 0 || page === "/search" || page === "/cart") return true;
    if (segments.length === 2 && ["products", "categories", "collections", "pages"].includes(segments[0]!)) {
      return /^[A-Za-z0-9_-]+$/.test(segments[1]!);
    }
    return segments.length === 1 && /^[A-Za-z0-9_-]+$/.test(segments[0]!) &&
      !PRIVATE_PATHS.has(segments[0]!.toLowerCase()) &&
      !segments[0]!.toLowerCase().startsWith("sitemap");
  } catch {
    return false;
  }
}

interface Continuation {
  url: string;
  method: "POST";
  fields: { continuationCode: string; path: string; device: Device };
}

export function isSafeThemePreviewContinuation(
  value: unknown,
  trustedOrigin: string,
  path: string,
  device: Device,
): value is Continuation {
  if (!value || typeof value !== "object") return false;
  const action = value as Partial<Continuation>;
  const fields = action.fields;
  if (
    action.method !== "POST" || typeof action.url !== "string" ||
    !fields || typeof fields !== "object" ||
    !/^tpc_[A-Za-z0-9_-]{48}$/.test(fields.continuationCode) ||
    fields.path !== path || fields.device !== device ||
    Object.keys(fields).length !== 3
  ) return false;
  try {
    const url = new URL(action.url);
    return url.origin === trustedOrigin && url.pathname === "/theme-preview/continue" &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/**
 * Opens the saved draft in a new tab: a popup at the storefront's
 * continuation relay, which receives the one-time code by postMessage (never
 * in a URL) and lands on the preview canvas. Resolves to "opened", or why it
 * could not.
 */
export function useOpenThemePreview() {
  return async (draftRevision: number, path: string, device: Device = "full", sourceRevision?: number): Promise<"opened" | "path" | "failed"> => {
    if (!isSafeThemePreviewPath(path)) return "path";
    const popup = window.open("about:blank", "_blank");
    if (!popup) return "failed";
    try {
      const { storefrontUrl } = await apiData(getApiV1Platform());
      const trustedOrigin = normalizeStorefrontOrigin(storefrontUrl);
      if (!trustedOrigin) throw new Error("Storefront origin is unavailable");
      const result = await apiData(postApiV1AdminSettingsThemePreviewSession({
        body: { expectedDraftRevision: draftRevision, ...(sourceRevision === undefined ? {} : { sourceRevision }), path, device },
      }));
      // A version preview answers with the version's revision, a draft preview with the draft's.
      if (
        result.draftRevision !== (sourceRevision ?? draftRevision) ||
        !isSafeThemePreviewContinuation(result.continuation, trustedOrigin, path, device) ||
        popup.closed
      ) throw new Error("Theme preview handoff is invalid");

      const destination = new URL(result.continuation.url);
      return await new Promise((resolve) => {
        const timeout = window.setTimeout(() => {
          window.removeEventListener("message", receive);
          popup.close();
          resolve("failed");
        }, 20_000);
        const receive = (event: MessageEvent) => {
          if (event.source !== popup || event.origin !== trustedOrigin || !event.data) return;
          if (event.data.type === "scalius-continuation-ready-v1") {
            popup.postMessage(
              { type: "scalius-continuation-fields-v1", fields: result.continuation.fields },
              trustedOrigin,
            );
          } else if (event.data.type === "scalius-continuation-accepted-v1") {
            window.clearTimeout(timeout);
            window.removeEventListener("message", receive);
            resolve("opened");
          }
        };
        window.addEventListener("message", receive);
        popup.location.replace(destination.toString());
      });
    } catch {
      popup.close();
      return "failed";
    }
  };
}

