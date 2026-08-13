const READY_MESSAGE = "scalius-continuation-ready-v1";
const FIELDS_MESSAGE = "scalius-continuation-fields-v1";
const ACCEPTED_MESSAGE = "scalius-continuation-accepted-v1";
const HANDOFF_TIMEOUT_MS = 15_000;

interface PreviewFields {
  continuationCode: string;
  path: string;
  device: "full" | "desktop" | "mobile";
}

interface PendingPreview {
  origin: string;
  ready: boolean;
  fields?: PreviewFields;
  resolve?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
}

const pendingPreviews = new WeakMap<Window, PendingPreview>();
let messageListenerInstalled = false;

function postPendingPreview(previewWindow: Window, pending: PendingPreview): void {
  if (!pending.ready || !pending.fields) return;
  previewWindow.postMessage({
    type: FIELDS_MESSAGE,
    fields: pending.fields,
  }, pending.origin);
}

function ensureMessageListener(): void {
  if (messageListenerInstalled) return;
  window.addEventListener("message", (event) => {
    const previewWindow = event.source as Window | null;
    if (!previewWindow) return;
    const pending = pendingPreviews.get(previewWindow);
    if (!pending || event.origin !== pending.origin || !event.data || typeof event.data !== "object") {
      return;
    }
    const type = (event.data as { type?: unknown }).type;
    if (type === READY_MESSAGE) {
      pending.ready = true;
      postPendingPreview(previewWindow, pending);
      return;
    }
    if (type === ACCEPTED_MESSAGE) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.resolve?.();
      pendingPreviews.delete(previewWindow);
    }
  });
  messageListenerInstalled = true;
}

export function prepareThemePreviewWindow({
  storefrontUrl,
}: {
  storefrontUrl: string;
}): Window | null {
  let destination: URL;
  try {
    const storefront = new URL(storefrontUrl);
    if (
      (storefront.protocol !== "https:" && storefront.protocol !== "http:") ||
      storefront.username ||
      storefront.password
    ) return null;
    destination = new URL("/theme-preview/continue", storefront);
  } catch {
    return null;
  }
  ensureMessageListener();
  const target = `scalius-theme-preview-${Date.now()}`;
  const previewWindow = window.open(destination.toString(), target);
  if (previewWindow) {
    pendingPreviews.set(previewWindow, {
      origin: destination.origin,
      ready: false,
    });
    previewWindow.focus();
  }
  return previewWindow;
}

export function submitThemePreview({
  previewWindow,
  storefrontUrl,
  continuation,
}: {
  previewWindow: Window;
  storefrontUrl: string;
  continuation: {
    url: string;
    method: "POST";
    fields: PreviewFields;
  };
}): Promise<void> {
  try {
    const storefront = new URL(storefrontUrl);
    const destination = new URL(continuation.url);
    const pending = pendingPreviews.get(previewWindow);
    if (
      (storefront.protocol !== "https:" && storefront.protocol !== "http:") ||
      storefront.username ||
      storefront.password ||
      destination.origin !== storefront.origin ||
      destination.pathname !== "/theme-preview/continue" ||
      destination.search ||
      destination.hash ||
      continuation.method !== "POST" ||
      !/^tpc_[A-Za-z0-9_-]{48}$/.test(continuation.fields.continuationCode) ||
      !["full", "desktop", "mobile"].includes(continuation.fields.device) ||
      !continuation.fields.path.startsWith("/") ||
      continuation.fields.path.length > 512 ||
      !pending ||
      pending.origin !== destination.origin
    ) {
      throw new Error("Invalid storefront preview destination");
    }
    return new Promise<void>((resolve, reject) => {
      pending.fields = continuation.fields;
      pending.resolve = resolve;
      pending.timeout = setTimeout(() => {
        pendingPreviews.delete(previewWindow);
        reject(new Error("Invalid storefront preview destination"));
      }, HANDOFF_TIMEOUT_MS);
      postPendingPreview(previewWindow, pending);
    });
  } catch {
    return Promise.reject(new Error("Invalid storefront preview destination"));
  }
}
