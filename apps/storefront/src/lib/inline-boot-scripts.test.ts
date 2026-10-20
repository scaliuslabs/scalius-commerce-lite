// @vitest-environment node
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { AD_CLICK_ID_SCRIPT, STALE_ASSET_RECOVERY_SCRIPT } from "./inline-boot-scripts";

function page(url: string, preview = false): Window {
  // Build files never load here: the error events below are dispatched by hand.
  const window = new Window({ url, settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  if (preview) window.document.documentElement.dataset.themePreview = "true";
  return window;
}

describe("ad click id script", () => {
  it("keeps valid click ids as cookies and session values and announces the cookie", () => {
    const window = page("https://shop.test/products/a?fbclid=AbC-1.2&gclid=%20G_9%20&msclkid=bad%20id&ttclid=T~1");
    let created = 0;
    window.addEventListener("storefront-cookie-created", () => { created += 1; });
    const before = Date.now();
    window.eval(AD_CLICK_ID_SCRIPT);
    const cookies = window.document.cookie;
    const fbc = /_fbc=fb\.1\.(\d+)\.AbC-1\.2/.exec(cookies);
    expect(fbc).not.toBeNull();
    expect(Number(fbc![1])).toBeGreaterThanOrEqual(before);
    expect(cookies).toContain("scalius_gclid=G_9");
    expect(cookies).toContain("scalius_ttclid=T~1");
    expect(cookies).not.toContain("scalius_msclkid");
    expect(window.sessionStorage.getItem("scalius_fbc")).toBe(`fb.1.${fbc![1]}.AbC-1.2`);
    expect(window.sessionStorage.getItem("scalius_gclid")).toBe("G_9");
    expect(window.sessionStorage.getItem("scalius_gbraid")).toBeNull();
    expect(created).toBe(3);
    window.close();
  });

  it("keeps click ids in memory only until the consent banner grants marketing (audit spec S4)", () => {
    const window = page("https://shop.test/products/a?fbclid=AbC-1.2&ttclid=T~1");
    (window as unknown as { __scaliusConsent: object }).__scaliusConsent = { analytics: false, marketing: false, saleOfData: false, source: "default" };
    window.eval(AD_CLICK_ID_SCRIPT);
    expect(window.document.cookie).toBe("");
    expect(window.sessionStorage.getItem("scalius_fbc")).toBeNull();
    expect((window as unknown as { __scaliusClickIds: Record<string, string> }).__scaliusClickIds).toMatchObject({
      _fbc: expect.stringMatching(/^fb\.1\.\d+\.AbC-1\.2$/),
      scalius_ttclid: "T~1",
    });
    window.close();
  });

  it("does nothing under a theme preview or without ids", () => {
    for (const window of [page("https://shop.test/?gclid=G1", true), page("https://shop.test/?q=shoes")]) {
      window.eval(AD_CLICK_ID_SCRIPT);
      expect(window.document.cookie).toBe("");
      window.close();
    }
  });
});

describe("stale asset recovery script", () => {
  it("reloads once for a failed build file and not again within 30 seconds", () => {
    const window = page("https://shop.test/");
    const reload = vi.fn();
    Object.defineProperty(window.location, "reload", { value: reload, configurable: true });
    window.eval(STALE_ASSET_RECOVERY_SCRIPT);
    const script = window.document.createElement("script");
    script.type = "text/plain"; // not run or fetched: the failure is dispatched below
    script.src = "https://shop.test/_astro/old.js";
    window.document.body.append(script);
    script.dispatchEvent(new window.Event("error"));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(Number(window.sessionStorage.getItem("_ar"))).toBeGreaterThan(0);
    // Other files are not ours to recover.
    const other = window.document.createElement("script");
    other.type = "text/plain";
    other.src = "https://cdn.shop.test/x.js";
    window.document.body.append(other);
    other.dispatchEvent(new window.Event("error"));
    expect(reload).toHaveBeenCalledTimes(1);

    const again = page("https://shop.test/");
    again.sessionStorage.setItem("_ar", String(Date.now()));
    const reloadAgain = vi.fn();
    Object.defineProperty(again.location, "reload", { value: reloadAgain, configurable: true });
    again.eval(STALE_ASSET_RECOVERY_SCRIPT);
    const stale = again.document.createElement("link");
    stale.href = "https://shop.test/_astro/old.css";
    again.document.head.append(stale);
    stale.dispatchEvent(new again.Event("error"));
    expect(reloadAgain).not.toHaveBeenCalled();
    window.close();
    again.close();
  });
});
