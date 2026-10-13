// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindBuyerInbox, stopBuyerInbox } from "./inbox-live";
vi.mock("@/lib/presence-url", () => ({ pagePath: (path: string) => path }));
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  document.body.innerHTML = `<ul data-buyer-inbox-live></ul><div data-buyer-inbox-empty>Empty</div><a data-buyer-inbox-older hidden></a><textarea>Unsent message</textarea>`;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true, data: { html: '<li><a href="/account/inbox/cnv_12345678">Store replied</a></li>', nextCursor: null } })));
});
afterEach(() => { stopBuyerInbox(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
it("receives inbox changes without refreshing the compose form", async () => {
  bindBuyerInbox(); await vi.advanceTimersByTimeAsync(30_001);
  expect(document.querySelector("ul")!.textContent).toBe("Store replied");
  expect(document.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Unsent message");
  expect(document.querySelector<HTMLElement>("[data-buyer-inbox-empty]")!.hidden).toBe(true);
});
it("does not poll a hidden tab and resumes when visible", async () => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  bindBuyerInbox(); await vi.advanceTimersByTimeAsync(60_000); expect(fetch).not.toHaveBeenCalled();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(1);
});
it("stops on expired access", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));
  bindBuyerInbox(); await vi.advanceTimersByTimeAsync(300_000); expect(fetch).toHaveBeenCalledTimes(1);
});
it("preserves a server throttle across focus and visibility changes", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "90" } }));
  bindBuyerInbox(); await vi.advanceTimersByTimeAsync(30_001);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(89_000); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000); expect(fetch).toHaveBeenCalledTimes(2);
});
it("never starts a loop on older inbox pages", async () => {
  document.querySelector("ul")!.removeAttribute("data-buyer-inbox-live");
  bindBuyerInbox(); await vi.advanceTimersByTimeAsync(60_000); expect(fetch).not.toHaveBeenCalled();
});
