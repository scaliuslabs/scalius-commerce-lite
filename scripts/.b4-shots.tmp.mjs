// Screenshots of presence on the product editor (preview dashboard on :4404), with
// presence injected into the page's own realtime seam (another staff member is
// a fake connection), at 1440 and 390, en and bn. Prints layout shift numbers.
import { chromium } from "playwright";
import { readAdminCredentials, signInStorageState } from "/Users/arob/Desktop/open/scalius-commerce-lite/.claude/worktrees/agent-a9b1403d94c9576f3/scripts/admin-quality/auth.mjs";

const root = "/Users/arob/Desktop/open/scalius-commerce-lite/.claude/worktrees/agent-a9b1403d94c9576f3";
const out = "/private/tmp/claude-501/-Users-arob-Desktop-open-scalius-commerce-lite/054076cc-e537-4307-a0ee-1b26f49f3eba/scratchpad/b4-shots";
const origin = "http://localhost:4404";
const target = process.argv[2] ?? "product";
const browser = await chromium.launch();
try {
  const stateFile = "/private/tmp/claude-501/-Users-arob-Desktop-open-scalius-commerce-lite/054076cc-e537-4307-a0ee-1b26f49f3eba/scratchpad/b4-state.json"; const { existsSync, writeFileSync } = await import("node:fs"); const state = existsSync(stateFile) ? stateFile : await signInStorageState(browser, origin, readAdminCredentials(root)); if (typeof state === "object") writeFileSync(stateFile, JSON.stringify(state));
  const probe = await browser.newContext({ storageState: state });
  let path;
  let key;
  if (target === "product") {
    const list = await (await probe.request.get(`${origin}/api/v1/admin/products?limit=1`)).json();
    const id = (list?.data?.products ?? list?.data?.items ?? list?.data ?? [])[0]?.id;
    path = `/admin/products/${id}/edit`;
    key = `product:${id}`;
  } else if (target === "order") {
    const list = await (await probe.request.get(`${origin}/api/v1/admin/orders?limit=1`)).json();
    const id = (list?.data?.orders ?? list?.data?.items ?? list?.data ?? [])[0]?.id;
    path = `/admin/orders/${id}`;
    key = `order:${id}`;
  } else {
    path = "/admin/settings/general";
    key = "settings:general";
  }
  await probe.close();
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    for (const locale of ["en", "bn"]) {
      const context = await browser.newContext({ storageState: state, viewport: { width, height } });
      await context.addInitScript((value) => localStorage.setItem("scalius.dashboard.locale", value), locale);
      const page = await context.newPage();
      await page.goto(`${origin}${path}`, { waitUntil: "load" });
      await page.waitForSelector("h1", { timeout: 30_000 });
      await page.waitForTimeout(9_000);
      const before = await page.evaluate(() => document.querySelector("h1")?.getBoundingClientRect().toJSON());
      const fieldBefore = await page.evaluate(() => document.querySelector("[name=name], [name=title], input[name]")?.getBoundingClientRect().toJSON());
      await page.evaluate(async (initialKey) => { let presenceKey = initialKey;
        const store = await import("/src/lib/realtime/store.tsx"); presenceKey = document.querySelector("[data-presence-root]")?.getAttribute("data-presence-root") ?? presenceKey;
        const listeners = new Set();
        const fake = {
          subscribe(listener) { listeners.add(listener); listener.status?.("open"); return () => listeners.delete(listener); },
          watch() { return () => {}; }, watchList() { return () => {}; }, announceSave() {}, focus() {}, getStatus: () => "open",
        };
        store.attachRealtime(fake, "me-preview");
        const field = document.querySelector(`[data-presence-root="${presenceKey}"] input[name]`)?.getAttribute("name") ?? "name";
        window.__presenceField = field;
        for (const listener of listeners) listener.presence?.(presenceKey, [
          { id: "usr_rahim", name: "Rahim Ahmed", editing: true, field },
          { id: "usr_sumi", name: "Sumi Akter" },
          { id: "usr_karim", name: "Karim Uddin" },
          { id: "usr_nadia", name: "Nadia Islam" },
          { id: "usr_tanvir", name: "Tanvir Hasan" },
        ]);
        for (const listener of listeners) listener.saved?.(presenceKey, { id: "usr_rahim", name: "Rahim Ahmed" }, null, [field]);
      }, key);
      await page.waitForTimeout(1_500);
      const after = await page.evaluate(() => document.querySelector("h1")?.getBoundingClientRect().toJSON());
      const fieldAfter = await page.evaluate(() => document.querySelector("[name=name], [name=title], input[name]")?.getBoundingClientRect().toJSON());
      const slots = await page.evaluate(() => ({
        avatars: [...document.querySelectorAll("[data-slot=presence] [role=img]")].map((node) => node.getAttribute("aria-label")),
        banner: document.querySelector("[data-slot=presence-banner]")?.textContent ?? null,
        notice: document.querySelector("[data-slot=presence-layer] [data-slot=alert]")?.textContent ?? null,
        rings: document.querySelectorAll("[data-slot=presence-layer] .ring-2").length,
        overflow: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth,
      }));
      console.log(JSON.stringify({ width, locale, path, h1Moved: [before?.top, after?.top, before?.left, after?.left], fieldMoved: [fieldBefore?.top, fieldAfter?.top], ...slots }));
      await page.screenshot({ path: `${out}/${target}-${width}-${locale}.png` });
      await context.close();
    }
  }
} finally {
  await browser.close();
}
