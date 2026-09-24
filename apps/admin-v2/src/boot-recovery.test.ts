// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const indexHtml = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
/** The body's inline script that watches the boot spinner. */
const recoveryScript = indexHtml.match(/<script>(setTimeout\([\s\S]*?)<\/script>/)?.[1] ?? "";

/** PERF-02: a first load that never mounts the app offers a reload instead of spinning forever. */
describe("dashboard boot spinner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.lang = "en";
    document.body.innerHTML = `<div id="root"><div id="boot" role="status" aria-label="Loading"></div></div>`;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.lang = "en";
  });

  const boot = () => document.getElementById("boot");

  it("says it is still loading and offers a reload after 12 seconds", () => {
    expect(recoveryScript).not.toBe("");
    new Function(recoveryScript)();
    vi.advanceTimersByTime(11_999);
    expect(boot()?.textContent).toBe("");
    vi.advanceTimersByTime(1);
    expect(boot()?.textContent).toBe("Still loading… Reload");
    expect(boot()?.querySelector("button")?.type).toBe("button");
    // The status is named by its message now.
    expect(boot()?.hasAttribute("aria-label")).toBe(false);
  });

  it("speaks Bangla when the dashboard is in Bangla", () => {
    document.documentElement.lang = "bn";
    new Function(recoveryScript)();
    vi.advanceTimersByTime(12_000);
    expect(boot()?.textContent).toBe("এখনো লোড হচ্ছে… আবার লোড করুন");
  });

  it("does nothing once the app has mounted", () => {
    new Function(recoveryScript)();
    document.getElementById("root")!.innerHTML = "<main>Home</main>";
    vi.advanceTimersByTime(12_000);
    expect(document.getElementById("root")?.textContent).toBe("Home");
  });
});
