// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindConversationForms, encodePhotos } from "./conversation-form";
const encode = vi.hoisted(() => ({ encodeImageAsWebp: vi.fn() }));
vi.mock("@scalius/shared/browser-image", () => encode);
vi.mock("@/lib/presence-url", () => ({ pagePath: (path: string) => path }));
vi.mock("./conversation-live", async (original) => ({ ...await original<typeof import("./conversation-live")>(), notifyConversationSent: vi.fn(() => false), appendConversationItems: vi.fn() }));
let form: HTMLFormElement;
let body: HTMLTextAreaElement;
let key: HTMLInputElement;
let resolve: (response: Response) => void;
beforeEach(() => {
  document.body.innerHTML = `<ol id="messages"><li data-seq="1">First message</li></ol><form data-conversation-form data-messages-target="messages" action="/api/conversations/cnv_12345678/messages"><input name="clientMessageKey" value="cmk_initial"><textarea name="body">First draft</textarea><input type="file" name="images"><div data-conversation-previews></div><p data-conversation-status></p><button type="submit" data-idle-label="Send" data-busy-label="Sending">Send</button></form>`;
  form = document.querySelector("form")!; body = form.querySelector("textarea")!; key = form.querySelector("input")!;
  vi.spyOn(form, "reportValidity").mockReturnValue(true);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
  bindConversationForms();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const submit = () => form.dispatchEvent(new Event("submit", { cancelable: true }));
const settle = async (response: Response) => { resolve(response); await new Promise((done) => setTimeout(done, 0)); };
const success = () => Response.json({ success: true, data: { conversationId: "cnv_12345678", items: [], hasOlder: false } }, { status: 201 });

describe("conversation draft lifecycle", () => {
  it("preserves text typed while a send is in flight and rotates the committed key", async () => {
    submit();
    body.value = "A new draft typed while waiting";
    await settle(success());
    expect(body.value).toBe("A new draft typed while waiting");
    expect(key.value).not.toBe("cmk_initial");
    expect(form.querySelector("button")!.disabled).toBe(false);
  });
  it("clears only the exact submitted text on success", async () => {
    submit(); await settle(success()); expect(body.value).toBe("");
  });
  it("retains the key for an unchanged ambiguous retry, and changes it for an edited retry", async () => {
    submit(); await settle(new Response(null, { status: 503 }));
    expect(key.value).toBe("cmk_initial"); expect(body.value).toBe("First draft");
    submit(); expect(key.value).toBe("cmk_initial"); await settle(new Response(null, { status: 503 }));
    body.value = "Edited message"; submit(); expect(key.value).not.toBe("cmk_initial");
    await settle(success());
  });
  it("does not clear or focus a new page's form after navigation", async () => {
    submit(); form.remove(); await settle(success()); expect(body.value).toBe("First draft");
  });
  it("prevents double submits while the request is pending", async () => {
    submit(); submit(); expect(fetch).toHaveBeenCalledTimes(1); await settle(success());
  });
  it("clears private drafts and ignores the old response after identity changes", async () => {
    body.value = "Private draft"; submit(); window.dispatchEvent(new Event("customer-logout"));
    await settle(success());
    expect(form.querySelector("button")!.disabled).toBe(true);
    expect(form.querySelector("[data-conversation-status]")!.textContent).toContain("account changed");
  });
});

describe("photos are encoded in the browser", () => {
  it("replaces each chosen photo with its WebP copy and keeps one the browser cannot encode", async () => {
    const jpeg = new File(["jpeg"], "lamp.jpg", { type: "image/jpeg" });
    const png = new File(["png"], "box.png", { type: "image/png" });
    encode.encodeImageAsWebp.mockImplementation(async (file: File) =>
      file === jpeg ? new File(["webp"], "lamp.webp", { type: "image/webp" }) : null);
    const data = new FormData();
    data.append("body", "Hello");
    data.append("images", jpeg);
    data.append("images", png);

    await encodePhotos(data, [jpeg, png]);

    const sent = data.getAll("images") as File[];
    expect(sent.map((file) => [file.name, file.type])).toEqual([["lamp.webp", "image/webp"], ["box.png", "image/png"]]);
    expect(data.get("body")).toBe("Hello");
  });
});

it("includes textarea borders and enables scrolling only after the draft reaches its cap", () => {
  form.dataset.conversationDock = "true";
  body.style.borderTop = "1px solid black"; body.style.borderBottom = "1px solid black";
  Object.defineProperty(body, "scrollHeight", { configurable: true, value: 44 });
  body.dispatchEvent(new Event("input"));
  expect(body.style.height).toBe("46px"); expect(body.style.overflowY).toBe("hidden");
  Object.defineProperty(body, "scrollHeight", { configurable: true, value: 200 });
  body.dispatchEvent(new Event("input"));
  expect(body.style.height).toBe("160px"); expect(body.style.overflowY).toBe("auto");
});
