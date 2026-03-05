export async function navigateTo(url: string): Promise<void> {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  root.classList.remove("admin-nav-loaded");
  root.classList.add("admin-nav-pending");

  const destination = new URL(url, window.location.origin);
  const isSameOrigin = destination.origin === window.location.origin;
  const target = isSameOrigin
    ? `${destination.pathname}${destination.search}${destination.hash}`
    : destination.toString();

  try {
    const { navigate } = await import("astro:transitions/client");
    await navigate(target);
    return;
  } catch {
    // Client router can be unavailable in some contexts; use hard navigation.
  }

  window.location.assign(target);
}
