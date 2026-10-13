// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as store from "./inbox-drafts";

beforeEach(() => { sessionStorage.clear(); store.clearInboxDrafts(); store.activateInboxDraftAccount("staff-a"); });
afterEach(() => { vi.unstubAllGlobals(); store.clearInboxDrafts(); vi.restoreAllMocks(); });
const write = (body: string, mode: store.DraftMode = "public", owner = "conversation:a") =>
  store.updateInboxDraft("staff-a", owner, mode, (draft) => ({ ...draft, body }));

it("keeps separate modes and owners, and purges previous-account and confirmed-logout drafts", () => {
  write("Reply"); write("Private note", "internal"); write("Other", "public", "conversation:b");
  expect(store.getInboxDrafts("staff-a", "conversation:a").internal.body).toBe("Private note");
  store.setInboxSearch("staff-a", "sensitive term");
  expect(store.getInboxSearch("staff-b")).toBe("");
  store.activateInboxDraftAccount("staff-b");
  expect(store.getInboxDrafts("staff-b", "conversation:a").public.body).toBe("");
  store.activateInboxDraftAccount("staff-a");
  expect(store.getInboxDrafts("staff-a", "conversation:a").public.body).toBe("");
  write("After login");
  store.clearInboxDrafts();
  expect(sessionStorage.length).toBe(0);
  expect(store.getInboxSearch("staff-a")).toBe("");
});

it("restores text and exact ambiguous attachment retry after reload, never blob URLs or filenames", async () => {
  const sent = { key: "retry-original", payload: { body: "Reply", visibility: "public" as const, attachmentIds: ["att_1"] } };
  store.updateInboxDraft("staff-a", "conversation:a", "public", (draft) => ({ ...draft, body: "Reply", attempt: sent,
    images: [{ attachmentId: "att_1", conversationId: "a", name: "private-name.png", preview: "blob:private", width: 10, height: 10 }] }));
  const bytes = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.getItem(sessionStorage.key(index)!)).join("");
  expect(bytes).not.toContain("private-name");
  expect(bytes).not.toContain("blob:");
  vi.resetModules();
  const reloaded = await import("./inbox-drafts");
  reloaded.activateInboxDraftAccount("staff-a");
  const recovered = reloaded.getInboxDrafts("staff-a", "conversation:a").public;
  expect(recovered).toMatchObject({ body: "Reply", images: [], omittedImages: 1, retryImages: true, attempt: sent });
  reloaded.clearInboxDrafts();
});

it("settles only the submitted mode and body after navigation; a signed-out completion cannot revive storage", () => {
  const sent = { key: "attempt-a", payload: { body: "A", visibility: "public" as const } };
  const epoch = store.inboxDraftGeneration();
  store.updateInboxDraft("staff-a", "conversation:a", "public", (draft) => ({ ...draft, body: "A", attempt: sent }));
  write("Private note", "internal");
  write("B");
  store.completeInboxDraft("staff-a", "conversation:a", "public", sent, epoch);
  expect(store.getInboxDrafts("staff-a", "conversation:a").public).toMatchObject({ body: "B", attempt: null });
  expect(store.getInboxDrafts("staff-a", "conversation:a").internal.body).toBe("Private note");
  store.clearInboxDrafts();
  store.activateInboxDraftAccount("staff-a");
  store.completeInboxDraft("staff-a", "conversation:a", "public", sent, epoch);
  expect(sessionStorage.length).toBe(1); // Account marker only.
});

it("bounds persisted drafts and preserves useful drafts while browsing empty threads", () => {
  for (let index = 0; index < 25; index++) write(`Draft ${index}`, "public", `conversation:${index}`);
  expect(sessionStorage.length).toBe(21); // 20 owners, plus account marker.
  for (let index = 30; index < 60; index++) write("", "public", `conversation:${index}`);
  expect(sessionStorage.length).toBe(21);
});

it("keeps typing usable and reports storage failure instead of claiming refresh persistence", () => {
  const storage = sessionStorage;
  vi.stubGlobal("sessionStorage", new Proxy(storage, {
    get(target, property) {
      if (property === "setItem") return () => { throw new Error("quota"); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }));
  write("Still editable");
  expect(store.getInboxDrafts("staff-a", "conversation:a")).toMatchObject({ storageFailed: true, public: { body: "Still editable" } });
});

it("never restores removed or replaced attachments as an old retry after reload", async () => {
  const image = (id: string) => ({ attachmentId: id, conversationId: "a", name: "photo.png", preview: "blob:photo", width: 10, height: 10 });
  const sent = { key: "old", payload: { body: "Reply", visibility: "public" as const, attachmentIds: ["a", "b"] } };
  store.updateInboxDraft("staff-a", "conversation:a", "public", (draft) => ({ ...draft, body: "Reply", attempt: sent, images: [image("a"), image("b")] }));
  store.updateInboxDraft("staff-a", "conversation:a", "public", (draft) => ({ ...draft, images: [image("a"), image("c")] }));
  vi.resetModules();
  const reloaded = await import("./inbox-drafts");
  reloaded.activateInboxDraftAccount("staff-a");
  expect(reloaded.getInboxDrafts("staff-a", "conversation:a").public).toMatchObject({ retryImages: false, omittedImages: 2, images: [] });
  reloaded.clearInboxDrafts();
});

it("reuses an ambiguous image-and-product attempt after reload regardless of property insertion order", async () => {
  const products = [{ productId: "product_1", skuId: "sku_1", title: "Product", variantLabel: null }];
  const payload: store.DraftPayload = { body: "Reply", visibility: "public", products: [{ productId: "product_1", skuId: "sku_1" }], attachmentIds: ["att_1"] };
  store.updateInboxDraft("staff-a", "conversation:a", "public", (draft) => ({ ...draft, body: payload.body, products,
    attempt: { key: "original-key", payload }, images: [{ attachmentId: "att_1", conversationId: "a", name: "image.png", preview: "blob:image", width: 10, height: 10 }] }));
  vi.resetModules();
  const reloaded = await import("./inbox-drafts");
  reloaded.activateInboxDraftAccount("staff-a");
  const recovered = reloaded.getInboxDrafts("staff-a", "conversation:a").public;
  expect(recovered.retryImages).toBe(true);
  expect(reloaded.sameDraftPayload(recovered.attempt!.payload, payload)).toBe(true);
  expect(recovered.attempt!.key).toBe("original-key");
  expect(reloaded.sameDraftPayload(recovered.attempt!.payload, { ...payload, products: [{ productId: "product_1", skuId: "sku_2" }] })).toBe(false);
  reloaded.clearInboxDrafts();
});
