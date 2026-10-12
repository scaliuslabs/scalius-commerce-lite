// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { libraryPreviewScript } from "./theme-preview-library";

const windows: Window[] = [];
afterEach(async () => { for (const page of windows.splice(0)) await page.happyDOM.close(); });
function start(markup: string, drawn: string[] = []) {
  const page = new Window({ url: "https://shop.test/theme-preview/library", settings: { enableJavaScriptEvaluation: true } });
  windows.push(page);
  page.document.body.innerHTML = markup;
  const postMessage = vi.fn();
  Object.defineProperty(page, "parent", { value: { postMessage } });
  for (const selector of drawn) page.document.querySelector(selector)!.getBoundingClientRect = () => new page.DOMRect(0, 0, 390, 200);
  const script = page.document.createElement("script");
  script.textContent = libraryPreviewScript("https://admin.shop.test", "document-1");
  page.document.body.append(script);
  page.dispatchEvent(new page.Event("load"));
  return { page, postMessage };
}
describe("library document readiness", () => {
  it("measures real section content through the canonical display:contents wrapper", () => {
    const { postMessage } = start('<div data-home-render-unit style="display:contents"><section><p>Eight real products</p></section></div>', ["section"]);
    expect(postMessage).toHaveBeenCalledWith({ type: "scalius:library-preview", v: "document-1", state: "ready" }, "https://admin.shop.test");
  });
  it("descends through a second app display:contents wrapper and truthfully reports no content", () => {
    const { postMessage } = start('<div data-home-render-unit style="display:contents"><div data-sx-app style="display:contents"><article>App section</article></div></div>', ["article"]);
    expect(postMessage.mock.calls[0]?.[0].state).toBe("ready");
    expect(start('<div data-home-render-unit style="display:contents"></div>').postMessage.mock.calls[0]?.[0].state).toBe("empty");
    expect(start('<div></div>').postMessage.mock.calls[0]?.[0].state).toBe("empty");
  });
  it("reports a renderer failure distinctly from intentional empty content", () => {
    expect(start('<div data-home-render-unit style="display:contents"><template data-library-render-failed></template></div>').postMessage.mock.calls[0]?.[0].state).toBe("failed");
    expect(start('<div data-home-render-unit style="display:contents"></div>').postMessage.mock.calls[0]?.[0].state).toBe("empty");
  });
  it("prevents navigation and delegated purchase/submit handlers", () => {
    const { page } = start('<a href="/cart">Buy</a><form><button>Pay</button></form>');
    const buy = vi.fn(); page.document.addEventListener("click", buy);
    const click = new page.MouseEvent("click", { bubbles: true, cancelable: true });
    page.document.querySelector("a")!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true); expect(buy).not.toHaveBeenCalled();
    const submit = new page.Event("submit", { bubbles: true, cancelable: true });
    page.document.querySelector("form")!.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
  });
});
