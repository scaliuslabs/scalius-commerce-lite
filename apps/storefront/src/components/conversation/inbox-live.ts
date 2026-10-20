import { pagePath } from "@/lib/presence-url";
import { conversationRequest, withPageLanguage } from "./conversation-live";
let stop: (() => void) | undefined;
/** Refresh only the latest visible inbox window. The compose disclosure is never replaced. */
export function bindBuyerInbox(): void {
  stop?.();
  const list = document.querySelector<HTMLElement>("[data-buyer-inbox-live]");
  if (!list) return;
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loading = false;
  let failures = 0;
  let activityAt = Date.now();
  let retryAt = 0;
  let reading: AbortController | undefined;
  const active = () => !lifetime.signal.aborted && list.isConnected && document.visibilityState !== "hidden" && navigator.onLine !== false;
  stop = () => { lifetime.abort(); reading?.abort(); clearTimeout(timer); };
  const schedule = (delay = 30_000) => { clearTimeout(timer); timer = undefined; if (active() && Date.now() - activityAt < 30 * 60_000) timer = setTimeout(() => { timer = undefined; void read(); }, Math.max(delay, retryAt - Date.now())); };
  const read = async () => {
    if (!active() || loading) return;
    loading = true;
    const current = new AbortController(); reading = current;
    const pending = conversationRequest(10_000, lifetime.signal, current.signal);
    try {
      const response = await fetch(withPageLanguage(new URL(pagePath("/api/conversations"), window.location.origin)), { headers: { Accept: "application/json" }, credentials: "same-origin", cache: "no-store", signal: pending.signal });
      if ([401, 403, 404].includes(response.status)) { stop?.(); return; }
      if (response.status === 429) {
        const retry = response.headers.get("Retry-After");
        const seconds = Number(retry);
        retryAt = Date.now() + Math.max(30_000, Number.isFinite(seconds) ? seconds * 1_000 : Math.max(0, Date.parse(retry ?? "") - Date.now()) || 30_000);
        return;
      }
      const answer = await response.json() as { success: boolean; data?: { html: string; nextCursor: string | null } };
      if (!response.ok || !answer.success || typeof answer.data?.html !== "string") throw new Error("unavailable");
      if (!active() || current.signal.aborted) return;
      const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLAnchorElement).getAttribute("href") : null;
      const template = document.createElement("template"); template.innerHTML = answer.data.html;
      template.content.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => { link.href = pagePath(link.getAttribute("href")!); });
      if (list.innerHTML !== template.innerHTML) {
        list.replaceChildren(template.content);
        if (focused) [...list.querySelectorAll<HTMLAnchorElement>("a")].find((link) => link.getAttribute("href") === focused)?.focus({ preventScroll: true });
      }
      list.hidden = list.children.length === 0;
      const empty = document.querySelector<HTMLElement>("[data-buyer-inbox-empty]"); if (empty) empty.hidden = !list.hidden;
      const older = document.querySelector<HTMLAnchorElement>("[data-buyer-inbox-older]");
      if (older) { older.hidden = !answer.data.nextCursor; if (answer.data.nextCursor) older.href = pagePath(`/account/inbox?${new URLSearchParams({ cursor: answer.data.nextCursor })}`); }
      failures = 0;
    } catch { if (!current.signal.aborted && !lifetime.signal.aborted) failures += 1; }
    finally { pending.done(); loading = false; reading = undefined; schedule(Math.min(120_000, 30_000 * 2 ** failures)); }
  };
  const wake = () => { if (active()) { activityAt = Date.now(); schedule(0); } else { clearTimeout(timer); timer = undefined; reading?.abort(); } };
  for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, () => { activityAt = Date.now(); if (!timer && !loading) schedule(0); }, { signal: lifetime.signal, passive: true });
  for (const type of ["focus", "online", "offline"]) window.addEventListener(type, wake, { signal: lifetime.signal });
  document.addEventListener("visibilitychange", wake, { signal: lifetime.signal });
  for (const type of ["customer-login", "customer-logout"]) window.addEventListener(type, () => { stop?.(); list.replaceChildren(); }, { signal: lifetime.signal });
  schedule();
}
export function stopBuyerInbox(): void { stop?.(); }
