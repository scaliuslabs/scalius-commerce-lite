import { useState } from "react";
import {
  getApiV1Platform,
  postApiV1AdminSettingsThemePreviewSession,
} from "@scalius/api-client/sdk";
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { apiData } from "~/lib/api";
import { SectionCard } from "./shared";

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
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length === 0 || parsed.pathname === "/search") return true;
    if (segments.length === 2 && ["products", "categories", "collections"].includes(segments[0]!)) {
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
  return async (draftRevision: number, path: string, device: Device = "full"): Promise<"opened" | "path" | "failed"> => {
    if (!isSafeThemePreviewPath(path)) return "path";
    const popup = window.open("about:blank", "_blank");
    if (!popup) return "failed";
    try {
      const { storefrontUrl } = await apiData(getApiV1Platform());
      const trustedOrigin = normalizeStorefrontOrigin(storefrontUrl);
      if (!trustedOrigin) throw new Error("Storefront origin is unavailable");
      const result = await apiData(postApiV1AdminSettingsThemePreviewSession({
        body: { expectedDraftRevision: draftRevision, path, device },
      }));
      if (
        result.draftRevision !== draftRevision ||
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

export function ThemePreviewAction({ draftRevision, disabled }: {
  draftRevision: number;
  disabled: boolean;
}) {
  const t = useMessages(onlineStoreMessages);
  const [path, setPath] = useState("/");
  const [device, setDevice] = useState<Device>("full");
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<"path" | "open" | null>(null);
  const open = useOpenThemePreview();

  const openPreview = async () => {
    setOpening(true);
    setError(null);
    const result = await open(draftRevision, path.trim(), device);
    setOpening(false);
    if (result !== "opened") setError(result === "path" ? "path" : "open");
  };

  return (
    <SectionCard title={t("themePreviewTitle")}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1 space-y-1">
          <Label htmlFor="theme-preview-path">{t("themePreviewPath")}</Label>
          <Input
            id="theme-preview-path"
            value={path}
            onChange={(event) => { setPath(event.target.value); setError(null); }}
            placeholder="/categories/keyboard"
            aria-describedby="theme-preview-path-help"
            aria-invalid={error === "path"}
          />
        </div>
        <div className="min-w-36 space-y-1">
          <Label htmlFor="theme-preview-device">{t("themePreviewDevice")}</Label>
          <SearchableSelect
            id="theme-preview-device"
            value={device}
            options={[
              { value: "full", label: t("themePreviewFull") },
              { value: "desktop", label: t("themePreviewDesktop") },
              { value: "mobile", label: t("themePreviewMobile") },
            ]}
            onValueChange={(value) => setDevice(value as Device)}
            triggerClassName="w-full"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || draftRevision < 1}
          loading={opening}
          onClick={() => void openPreview()}
        >
          {t("themePreviewOpen")}
        </Button>
      </div>
      <p id="theme-preview-path-help" className="mt-2 text-body text-muted-foreground">
        {draftRevision < 1 ? t("themePreviewSaveFirst") : t("themePreviewPathHelp")}
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-body text-destructive">
          {t(error === "path" ? "themePreviewInvalidPath" : "themePreviewFailed")}
        </p>
      ) : null}
    </SectionCard>
  );
}
