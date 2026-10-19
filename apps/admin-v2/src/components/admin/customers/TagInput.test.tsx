// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { customersMessages } from "~/i18n/customers";

vi.mock("@scalius/api-client/sdk", () => ({ getApiV1AdminCustomersTags: vi.fn() }));

import { TagInput } from "./TagInput";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof customersMessages.en, vars?: Record<string, string | number>) => translate(customersMessages, key, vars);

let latest: string[] = [];
function Harness({ initial, max = 50 }: { initial: string[]; max?: number }) {
  const [tags, setTags] = useState(initial);
  latest = tags;
  return <TagInput id="tags" value={tags} onChange={setTags} max={max} suggest={false} />;
}

const field = () => document.getElementById("tags") as HTMLInputElement;

async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string) {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("tag input", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(initial: string[], max?: number) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <Harness initial={initial} max={max} />
        </QueryClientProvider>,
      );
    });
  }

  it("adds a typed tag on Enter, normalised as stored, and removes the last one with Backspace", async () => {
    await render(["vip"]);
    await type("  Big   Spender ");
    await press("Enter");
    expect(latest).toEqual(["vip", "big spender"]);
    expect(field().value).toBe("");
    await press("Backspace");
    expect(latest).toEqual(["vip"]);
    expect(container.querySelector(`button[aria-label="${t("removeTag", { tag: "vip" })}"]`)).not.toBeNull();
  });

  it("adds every complete part of a pasted list and keeps the rest typing", async () => {
    await render([]);
    await type("eid, wholesale, dha");
    expect(latest).toEqual(["eid", "wholesale"]);
    expect(field().value).toBe(" dha");
  });

  it("says why a tag was not added", async () => {
    await render([], 1);
    await type("x".repeat(41));
    await press("Enter");
    expect(latest).toEqual([]);
    expect(container.textContent).toContain(t("tagTooLong", { count: 40 }));
    await type("one, two");
    expect(latest).toEqual(["one"]);
    expect(container.textContent).toContain(t("tagLimit", { count: 1 }));
  });

  it("keeps a tag too long to save in the field, and says its length and the saved form while typing", async () => {
    await render([]);
    const long = "Wholesale buyers from the Chittagong port area 2026 list"; // 56 characters
    await type(long);
    // Before it is added: how long it is against the limit.
    expect(container.textContent).toContain(t("tagTooLongNow", { length: 56, count: 40 }));
    expect(field().getAttribute("aria-invalid")).toBe("true");
    await press("Enter");
    // Not dropped: it stays to be shortened, with the reason.
    expect(latest).toEqual([]);
    expect(field().value).toBe(long);
    expect(container.textContent).toContain(t("tagTooLong", { count: 40 }));

    await type("VIP  Customers");
    expect(container.textContent).toContain(t("tagSavedAs", { tag: "vip customers" }));
    await press("Enter");
    expect(latest).toEqual(["vip customers"]);
  });
});
