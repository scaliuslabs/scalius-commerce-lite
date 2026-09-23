// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPartytownBootstrap,
  partytownConfig,
  partytownForwardFor,
} from "./partytown-config";

type TestWindow = Window & {
  partytown?: { forward?: string[] };
  fbq?: (...args: unknown[]) => void;
  gtag?: (...args: unknown[]) => void;
  ttq?: { track?: (...args: unknown[]) => void };
  dataLayer?: unknown[];
  __scaliusPtq?: unknown[];
};
const testWindow = window as TestWindow;

function script(type: string, config: string, usePartytown = true) {
  return { type, config, usePartytown };
}

afterEach(() => {
  for (const key of ["partytown", "fbq", "gtag", "ttq", "dataLayer", "__scaliusPtq"] as const) {
    delete testWindow[key];
  }
  document.head.innerHTML = "";
  vi.useRealTimers();
});

describe("partytownForwardFor", () => {
  it("forwards nothing when no enabled script runs in Partytown", () => {
    expect(partytownForwardFor([])).toEqual([]);
    expect(
      partytownForwardFor([
        script("facebook_pixel", "<script>fbq('init','1')</script>", false),
        script("cloudflare_web_analytics", "<script src=\"https://static.cloudflareinsights.com/beacon.min.js\"></script>", false),
      ]),
    ).toEqual([]);
  });

  it("forwards only the globals of the Partytown providers on the page", () => {
    expect(partytownForwardFor([script("facebook_pixel", "<script>fbq('init','1')</script>")])).toEqual(["fbq"]);
    expect(partytownForwardFor([script("google_tag_manager", "<script>(function(w){w.dataLayer=[]})</script>")])).toEqual(["dataLayer.push"]);
    expect(partytownForwardFor([script("google_analytics", "<script>gtag('config','G-1')</script>")])).toEqual(["dataLayer.push", "gtag"]);
    expect(partytownForwardFor([script("tiktok_pixel", "<script>ttq.load('X')</script>")])).toEqual(["ttq.load", "ttq.page", "ttq.track"]);
  });

  it("detects providers inside custom Partytown snippets", () => {
    expect(
      partytownForwardFor([
        script("custom", "<script src=\"https://connect.facebook.net/en_US/fbevents.js\"></script>"),
      ]),
    ).toEqual(["fbq"]);
  });
});

describe("buildPartytownBootstrap", () => {
  function run(forward: string[]) {
    new Function(buildPartytownBootstrap(forward, "/~partytown/scalius-loader.abc.js"))();
  }

  it("installs stubs only for forwarded globals and hands the list to Partytown", () => {
    run(["fbq"]);
    expect(testWindow.partytown?.forward).toEqual(["fbq"]);
    expect(typeof testWindow.fbq).toBe("function");
    expect(testWindow.gtag).toBeUndefined();
    expect(testWindow.ttq).toBeUndefined();
  });

  it("queues calls and loads the runtime after load and two frames", async () => {
    vi.useFakeTimers();
    run(["fbq", "dataLayer.push"]);
    testWindow.fbq?.("track", "PageView");
    testWindow.dataLayer?.push({ event: "view" });
    expect(Array.from(testWindow.dataLayer ?? [])).toEqual([{ event: "view" }]);
    expect(testWindow.__scaliusPtq).toHaveLength(2);
    expect(document.head.querySelector("script")).toBeNull();

    window.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(document.head.querySelector("script")?.getAttribute("src")).toBe(
      "/~partytown/scalius-loader.abc.js",
    );
  });
});

describe("partytownConfig", () => {
  it("proxies known analytics scripts through the same-origin proxy", () => {
    const originalUrl = new URL(
      "https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=PIXEL_ID&lib=ttq",
    );
    const resolved = partytownConfig.resolveUrl(
      originalUrl,
      { origin: "https://store.example.com" } as Location,
      "script",
    );

    expect(resolved.origin).toBe("https://store.example.com");
    expect(resolved.pathname).toBe("/api/ptproxy");
    expect(resolved.searchParams.get("url")).toBe(originalUrl.href);
    expect(partytownConfig).not.toHaveProperty("forward");
  });
});
