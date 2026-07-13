import { parseNavigationHref } from "@scalius/shared/navigation-href";

export function resolveNavigationPreviewDestination(
  href: string | undefined,
  getStorefrontPath: (path: string) => string,
): string | null {
  const result = parseNavigationHref(href);
  if (!result.ok || !result.href) return null;

  if (result.kind === "external") return result.href;

  const path = result.href.startsWith("/") ? result.href : `/${result.href}`;
  return getStorefrontPath(path);
}

export function openNavigationPreview(
  href: string | undefined,
  getStorefrontPath: (path: string) => string,
): void {
  const destination = resolveNavigationPreviewDestination(href, getStorefrontPath);
  if (!destination) return;

  const preview = window.open(destination, "_blank", "noopener,noreferrer");
  if (preview) preview.opener = null;
}
