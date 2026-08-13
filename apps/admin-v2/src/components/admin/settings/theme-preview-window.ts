export function prepareThemePreviewWindow({
  storefrontUrl,
}: {
  storefrontUrl: string;
}): Window | null {
  try {
    const storefront = new URL(storefrontUrl);
    if (
      (storefront.protocol !== "https:" && storefront.protocol !== "http:") ||
      storefront.username ||
      storefront.password
    ) return null;
  } catch {
    return null;
  }
  const target = `scalius-theme-preview-${Date.now()}`;
  const previewWindow = window.open("about:blank", target);
  previewWindow?.focus();
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
    fields: {
      continuationCode: string;
      path: string;
      device: "full" | "desktop" | "mobile";
    };
  };
}): Promise<void> {
  try {
    const storefront = new URL(storefrontUrl);
    const destination = new URL(continuation.url);
    if (
      (storefront.protocol !== "https:" && storefront.protocol !== "http:") ||
      storefront.username ||
      storefront.password ||
      destination.origin !== storefront.origin ||
      destination.pathname !== "/theme-preview/continue" ||
      destination.search ||
      destination.hash ||
      continuation.method !== "POST" ||
      !/^tpc_[A-Za-z0-9_-]{48}$/.test(
        continuation.fields.continuationCode,
      ) ||
      !["full", "desktop", "mobile"].includes(continuation.fields.device) ||
      !continuation.fields.path.startsWith("/") ||
      continuation.fields.path.length > 512 ||
      !previewWindow.name
    ) {
      throw new Error("Invalid storefront preview destination");
    }
    const bytes = new TextEncoder().encode(JSON.stringify(continuation.fields));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const payload = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    previewWindow.name = `scalius-continuation-v1:${payload}`;
    previewWindow.location.replace(destination.toString());
    return Promise.resolve();
  } catch {
    return Promise.reject(new Error("Invalid storefront preview destination"));
  }
}
