import {
  isThemePreviewHandoffMessage,
  isThemePreviewToken,
  THEME_PREVIEW_HANDOFF_ACCEPTED,
  THEME_PREVIEW_HANDOFF_FAILED,
  THEME_PREVIEW_HANDOFF_READY,
  THEME_PREVIEW_HANDOFF_TOKEN,
} from "@scalius/shared/theme-preview-handoff";

import {
  buildThemePreviewHandoffUrl,
  type ThemePreviewDevice,
} from "./theme-workspace";

export function prepareThemePreviewWindow({
  storefrontUrl,
  path,
  device,
}: {
  storefrontUrl: string;
  path: string;
  device: ThemePreviewDevice;
}): Window | null {
  const destination = buildThemePreviewHandoffUrl(storefrontUrl, path, device);
  if (!destination) return null;
  const target = `scalius-theme-preview-${Date.now()}`;
  const previewWindow = window.open(destination, target);
  previewWindow?.focus();
  return previewWindow;
}

export function submitThemePreview({
  previewWindow,
  storefrontUrl,
  token,
  timeoutMs = 15_000,
}: {
  previewWindow: Window;
  storefrontUrl: string;
  token: string;
  timeoutMs?: number;
}): Promise<void> {
  if (!isThemePreviewToken(token)) {
    return Promise.reject(new Error("Invalid storefront preview token"));
  }

  let storefrontOrigin = "";
  try {
    const parsed = new URL(storefrontUrl);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error("Invalid storefront preview destination");
    }
    storefrontOrigin = parsed.origin;
  } catch {
    return Promise.reject(new Error("Invalid storefront preview destination"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("message", receiveMessage);
      if (error) reject(error);
      else resolve();
    };
    const receiveMessage = (event: MessageEvent) => {
      if (event.origin !== storefrontOrigin || event.source !== previewWindow) return;
      if (isThemePreviewHandoffMessage(event.data, THEME_PREVIEW_HANDOFF_READY)) {
        previewWindow.postMessage(
          { type: THEME_PREVIEW_HANDOFF_TOKEN, token },
          storefrontOrigin,
        );
        return;
      }
      if (isThemePreviewHandoffMessage(event.data, THEME_PREVIEW_HANDOFF_ACCEPTED)) {
        finish();
        return;
      }
      if (isThemePreviewHandoffMessage(event.data, THEME_PREVIEW_HANDOFF_FAILED)) {
        finish(new Error("Storefront rejected the saved draft preview"));
      }
    };
    const timeout = window.setTimeout(() => {
      finish(new Error("Storefront preview handshake timed out"));
    }, timeoutMs);
    window.addEventListener("message", receiveMessage);
  });
}
