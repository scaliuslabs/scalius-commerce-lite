// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { serializeJsonForInlineScript } from "./safe-json";

describe("serializeJsonForInlineScript", () => {
  it("keeps JSON parseable while preventing inline script breakout", () => {
    const payload = {
      gateway: {
        name: '</script><img src=x onerror="window.__pwned=true">',
        note: "line\u2028separator & paragraph\u2029separator",
      },
    };

    const serialized = serializeJsonForInlineScript(payload);
    const inlineScript = `window.__CHECKOUT_CONFIG__=${serialized};`;
    const doc = new DOMParser().parseFromString(
      `<script>${inlineScript}</script>`,
      "text/html",
    );

    expect(serialized).not.toContain("</script");
    expect(serialized).not.toContain("<img");
    expect(inlineScript).not.toContain("</script");
    expect(doc.querySelectorAll("script")).toHaveLength(1);
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("script")?.textContent).toContain(
      "\\u003C/script",
    );
    expect(JSON.parse(serialized)).toEqual(payload);
  });
});
