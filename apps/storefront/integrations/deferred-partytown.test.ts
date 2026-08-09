import { describe, expect, it } from "vitest";

import { buildDeferredPartytownBootstrap } from "./deferred-partytown.mjs";

describe("deferred Partytown bootstrap", () => {
  it("queues calls before loading the runtime after load and two frames", () => {
    const source = buildDeferredPartytownBootstrap({
      forward: [
        "fbq",
        ["dataLayer.push", { preserveBehavior: true }],
        "ttq.track",
      ],
      loaderPath: "/~partytown/scalius-loader.abc123.js",
    });

    expect(source).toContain(
      '["fbq","dataLayer.push","ttq.track"]',
    );
    expect(source).toContain("w.addEventListener('load',g,{once:true})");
    expect(source).toContain("r(function(){r(h)})");
    expect(source).toContain("['pointerdown','keydown','touchstart']");
    expect(source).toContain(
      '"/~partytown/scalius-loader.abc123.js"',
    );
    expect(source).toContain("var b=q.splice(0)");
    expect(source).toContain("setTimeout(h,4000)");
  });
});
