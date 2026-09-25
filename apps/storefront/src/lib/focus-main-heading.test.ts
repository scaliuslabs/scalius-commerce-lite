// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { focusMainHeading, focusMainHeadingIfLost } from "./focus-main-heading";

afterEach(() => { document.body.innerHTML = ""; });

describe("focus after the page changed under a dialog", () => {
  it("focuses the shown heading in main, skipping hidden states and the header", () => {
    document.body.innerHTML = `<header><h1>Store</h1></header><main><div class="hidden"><h1>Sign in to see your orders</h1></div><div><h1>Account</h1></div></main>`;

    expect(focusMainHeading()).toBe(true);
    expect(document.activeElement?.textContent).toBe("Account");
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  });

  it("moves focus only when it was lost to the body or a now-hidden control", () => {
    document.body.innerHTML = `<main><h1>Order #1101</h1><button id="kept">Buy again</button><div id="gone"><button id="opener">Sign in</button></div></main>`;
    const kept = document.getElementById("kept")!;
    kept.focus();
    expect(focusMainHeadingIfLost()).toBe(false);
    expect(document.activeElement).toBe(kept);

    document.getElementById("opener")!.focus();
    document.getElementById("gone")!.hidden = true;
    expect(focusMainHeadingIfLost()).toBe(true);
    expect(document.activeElement?.textContent).toBe("Order #1101");
  });
});
