import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { buildPrivateSessionPrefetchGuardScript } from "./private-session-prefetch-guard";

function createPage(initiallySuppressed: boolean): Window {
  const page = new Window();
  page.document.body.innerHTML = [
    '<a id="public" href="/products/example">Product</a>',
    '<a id="explicit" href="/cart" data-astro-prefetch="false">Cart</a>',
    '<a id="hover" href="/categories/example" data-astro-prefetch="hover">Category</a>',
  ].join("");
  page.eval(buildPrivateSessionPrefetchGuardScript(initiallySuppressed));
  return page;
}

function getAnchor(page: Window, selector: string): HTMLAnchorElement {
  return page.document.querySelector(selector) as unknown as HTMLAnchorElement;
}

describe("private session prefetch guard", () => {
  it("suppresses initial and dynamically added anchors before Astro can scan them", async () => {
    const page = createPage(true);
    const publicAnchor = getAnchor(page, "#public");
    const explicitAnchor = getAnchor(page, "#explicit");
    expect(publicAnchor.dataset.astroPrefetch).toBe("false");
    expect(publicAnchor.hasAttribute("data-storefront-session-prefetch")).toBe(true);
    expect(explicitAnchor.dataset.astroPrefetch).toBe("false");
    expect(explicitAnchor.hasAttribute("data-storefront-session-prefetch")).toBe(false);

    const dynamicAnchor = page.document.createElement("a");
    dynamicAnchor.href = "/search?q=shoes";
    page.document.body.append(dynamicAnchor);
    await page.happyDOM.waitUntilComplete();

    expect(dynamicAnchor.dataset.astroPrefetch).toBe("false");
    expect(dynamicAnchor.hasAttribute("data-storefront-session-prefetch")).toBe(true);
    page.close();
  });

  it("blocks existing hover handlers after login for the document lifetime", () => {
    const page = createPage(false);
    const publicAnchor = getAnchor(page, "#public");
    const hoverAnchor = getAnchor(page, "#hover");
    let hoverCalls = 0;
    publicAnchor.addEventListener("mouseenter", () => {
      hoverCalls += 1;
    });

    expect(publicAnchor.dataset.astroPrefetch).toBeUndefined();
    page.dispatchEvent(new page.CustomEvent("customer-login"));
    expect(publicAnchor.dataset.astroPrefetch).toBe("false");
    expect(hoverAnchor.dataset.astroPrefetch).toBe("false");

    publicAnchor.dispatchEvent(
      new page.MouseEvent("mouseenter") as unknown as Event,
    );
    expect(hoverCalls).toBe(0);

    page.dispatchEvent(new page.CustomEvent("customer-logout"));
    expect(publicAnchor.dataset.astroPrefetch).toBe("false");
    expect(hoverAnchor.dataset.astroPrefetch).toBe("false");

    publicAnchor.dispatchEvent(
      new page.MouseEvent("mouseenter") as unknown as Event,
    );
    expect(hoverCalls).toBe(0);
    page.close();
  });

  it("suppresses prefetch after an attribution cookie is created", () => {
    const page = createPage(false);
    const publicAnchor = getAnchor(page, "#public");

    page.dispatchEvent(new page.CustomEvent("storefront-cookie-created"));

    expect(publicAnchor.dataset.astroPrefetch).toBe("false");
    page.close();
  });
});
