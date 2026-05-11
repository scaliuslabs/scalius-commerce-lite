import { describe, expect, it } from "vitest";

import {
  isStandaloneShortcodeContent,
  unwrapParagraphWrappedShortcodes,
} from "../../../apps/storefront/src/lib/shortcode-content";
import {
  normalizeWidgetCss,
  normalizeWidgetHtml,
} from "../../../apps/storefront/src/lib/widget-content";

describe("storefront shortcode content helpers", () => {
  it("detects CMS pages whose entire content is a widget shortcode", () => {
    expect(
      isStandaloneShortcodeContent(
        '<p>[widget id="wid_LU4jVqIung-GZ8ucIRRoM"]</p>',
      ),
    ).toBe(true);
    expect(
      isStandaloneShortcodeContent('[product slug="rockstar-energy"]'),
    ).toBe(true);
  });

  it("does not treat mixed rich content as a standalone shortcode page", () => {
    expect(
      isStandaloneShortcodeContent(
        '<h2>Deals</h2><p>[widget id="wid_LU4jVqIung-GZ8ucIRRoM"]</p>',
      ),
    ).toBe(false);
  });

  it("unwraps paragraph-wrapped block shortcodes before rendering", () => {
    expect(
      unwrapParagraphWrappedShortcodes(
        '<h2>Deals</h2><p class="editor-paragraph">[widget id="wid_123"]</p>',
      ),
    ).toBe('<h2>Deals</h2>[widget id="wid_123"]');
  });

  it("normalizes tag-wrapped widget HTML and CSS from AI responses", () => {
    expect(
      normalizeWidgetHtml("<htmljs>\n<section>Hero</section>\n</htmljs>"),
    ).toBe("<section>Hero</section>");
    expect(normalizeWidgetCss("<css>\n.hero { color: red; }\n</css>")).toBe(
      ".hero { color: red; }",
    );
  });

  it("repairs common generated CSS comment typos", () => {
    expect(
      normalizeWidgetCss(
        "<css>\n/* Hero Section /\n.hero { min-height: 100vh; / Full viewport height */ }\n</css>",
      ),
    ).toContain(
      "/* Hero Section */\n.hero { min-height: 100vh; /* Full viewport height */ }",
    );
  });
});
