export async function navigateTo(url: string): Promise<void> {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  root.classList.remove("admin-nav-loaded");
  root.classList.add("admin-nav-pending");

  try {
    const { navigate } = await import("astro:transitions/client");
    await navigate(url);
    return;
  } catch {
    // Client router can be unavailable in some contexts; use hard navigation.
  }

  window.location.href = url;
}
