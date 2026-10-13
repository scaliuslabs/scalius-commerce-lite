// @vitest-environment happy-dom
// Presence on an editor (DESIGN.md W1–W5): the reserved avatar box, the
// editing banner (dismissed until someone new edits), field focus reports
// scoped to the editor, the save notice that merges a clean draft at once or
// says "reload", and list presence.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimePresence } from "@scalius/shared/realtime";
import type { RealtimeListener } from "~/lib/realtime/connection";
import { PresenceSlot, attachRealtime } from "~/lib/realtime/store";
import { changedFieldNames } from "~/lib/realtime/changed-fields";
import { fieldKeyOf } from "~/lib/realtime/presence-dom";
import { useListPresence } from "~/lib/realtime/list-presence";
import { fieldsOverlap, saveOutcome } from "./PresenceLayer";
import { RowPresence } from "./RowPresence";
import { setLocale } from "~/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "product:prd_1";

function fakeConnection() {
  const listeners = new Set<RealtimeListener>();
  const focus = vi.fn();
  const watch = vi.fn(() => () => undefined);
  const watchList = vi.fn(() => () => undefined);
  return {
    focus,
    watch,
    watchList,
    announceSave: vi.fn(),
    getStatus: () => "open" as const,
    subscribe(listener: RealtimeListener) {
      listeners.add(listener);
      listener.status?.("open");
      return () => listeners.delete(listener);
    },
    presence(key: string, people: RealtimePresence[]) {
      for (const listener of listeners) listener.presence?.(key, people);
    },
    saved(key: string, fields: string[], rev = 9) {
      for (const listener of listeners) listener.saved?.(key, { id: "usr_karim", name: "Karim Uddin" }, rev, fields);
    },
  };
}

let host: HTMLDivElement;
let root: Root;
let connection: ReturnType<typeof fakeConnection>;

/** Renders and waits for the lazily loaded presence view. */
async function renderEditor(element: React.ReactElement) {
  await act(async () => root.render(element));
  await vi.waitFor(() => expect(connection.watch).toHaveBeenCalled());
  await flush();
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function Editor({ dirty = false, readOnly = false, changed = [] as string[], onLoadLatest }: { dirty?: boolean; readOnly?: boolean; changed?: string[]; onLoadLatest?: () => void }) {
  return (
    <>
      <h1>Cotton panjabi</h1>
      <PresenceSlot presenceKey={KEY} revision={4} dirty={dirty} readOnly={readOnly} changedFields={() => changed} onLoadLatest={onLoadLatest} />
      <form data-presence-root={KEY}>
        <label htmlFor="price">Price</label>
        <input id="price" name="price" />
        <label htmlFor="stock">Stock</label>
        <input id="stock" name="stock" />
      </form>
      <input name="outside" />
    </>
  );
}

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  connection = fakeConnection();
  attachRealtime(connection, "usr_me");
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  attachRealtime(null);
});

describe("editor presence", () => {
  it("reserves the avatar box, then shows named avatars without moving it", async () => {
    await renderEditor(<Editor />);
    const slot = host.querySelector("[data-slot=presence-avatars]")!;
    expect(slot).not.toBeNull();
    expect(slot.className).toContain("w-24");
    expect(slot.children).toHaveLength(0);

    await act(async () => connection.presence(KEY, [
      { id: "usr_me", name: "Me" },
      { id: "usr_rahim", name: "Rahim Ahmed", editing: true, field: "price" },
      { id: "usr_sumi", name: "Sumi" },
    ]));
    await flush();
    const avatars = [...slot.querySelectorAll("[role=img]")].filter((avatar) => !avatar.closest("[data-slot=presence-layer]"));
    expect(avatars.map((avatar) => avatar.getAttribute("aria-label"))).toEqual(["Rahim Ahmed, editing", "Sumi, viewing"]);
    expect(avatars[0]!.textContent).toBe("RA");
  });

  it("shows the editing banner, keeps it dismissed for the same people, and brings it back for someone new", async () => {
    await renderEditor(<Editor onLoadLatest={vi.fn()} />);
    await act(async () => connection.presence(KEY, [{ id: "usr_rahim", name: "Rahim", editing: true }]));
    await flush();
    const banner = () => document.querySelector("[data-slot=presence-banner]");
    expect(banner()?.textContent).toContain("Rahim is editing this product.");
    expect(banner()?.textContent).toContain("Your changes to different fields merge automatically.");

    await act(async () => [...banner()!.querySelectorAll("button")].find((button) => button.textContent === "Dismiss")!.click());
    expect(banner()).toBeNull();
    await act(async () => connection.presence(KEY, [{ id: "usr_rahim", name: "Rahim", editing: true }, { id: "usr_sumi", name: "Sumi" }]));
    expect(banner()).toBeNull();
    await act(async () => connection.presence(KEY, [{ id: "usr_rahim", name: "Rahim", editing: true }, { id: "usr_sumi", name: "Sumi", editing: true }]));
    expect(banner()?.textContent).toContain("Rahim and Sumi are editing this product.");
  });

  it("reports the field this tab is in, only inside its editor, never a value", async () => {
    await renderEditor(<Editor />);
    const price = host.querySelector<HTMLInputElement>("input[name=price]")!;
    price.value = "1200";
    await act(async () => price.focus());
    expect(connection.focus).toHaveBeenLastCalledWith(KEY, "price", false);
    await act(async () => host.querySelector<HTMLInputElement>("input[name=outside]")!.focus());
    expect(connection.focus).toHaveBeenLastCalledWith(KEY, null, false);
    await act(async () => root.render(<Editor dirty />));
    expect(connection.focus).toHaveBeenLastCalledWith(KEY, null, true);
    expect(JSON.stringify(connection.focus.mock.calls)).not.toContain("1200");
  });

  it("keeps viewers in presence without claiming they edit focused read-only controls", async () => {
    await renderEditor(<Editor readOnly dirty />);
    await act(async () => host.querySelector<HTMLInputElement>("input[name=price]")!.focus());
    expect(connection.watch).toHaveBeenCalledWith(KEY);
    expect(connection.focus.mock.calls.every(([, field, dirty]) => field === null && dirty === false)).toBe(true);
  });

  it("never promises merging or draft preservation on an editor without that capability", async () => {
    await renderEditor(<Editor dirty changed={["stock"]} />);
    await act(async () => connection.presence(KEY, [{ id: "usr_rahim", name: "Rahim", editing: true }]));
    await flush();
    expect(document.querySelector("[data-slot=presence-banner]")?.textContent).not.toContain("merge automatically");
    await act(async () => connection.saved(KEY, ["price"]));
    await flush();
    const notice = document.querySelector("[data-slot=alert]")!;
    expect(notice.textContent).not.toContain("which you changed too");
    expect(notice.textContent).not.toContain("your edits stay");
    expect(notice.textContent).not.toContain("merged into your draft");
  });

  it("merges a save into a dirty draft at once when the fields differ, with links to them", async () => {
    const onLoadLatest = vi.fn();
    await renderEditor(<Editor dirty changed={["stock"]} onLoadLatest={onLoadLatest} />);
    await act(async () => connection.saved(KEY, ["price"]));
    await flush();
    expect(onLoadLatest).toHaveBeenCalledTimes(1);
    const alert = document.querySelector("[data-slot=alert]")!;
    expect(alert.textContent).toContain("Karim Uddin saved Price: merged into your draft");
    const link = [...alert.querySelectorAll("button")].find((button) => button.textContent === "Price")!;
    // happy-dom lays nothing out: give the fields a box.
    const price = host.querySelector<HTMLInputElement>("input[name=price]")!;
    Object.defineProperties(price, {
      offsetWidth: { value: 200 },
      offsetHeight: { value: 36 },
      getClientRects: { value: () => [{ width: 200, height: 36 }] },
      scrollIntoView: { value: vi.fn() },
    });
    await act(async () => link.click());
    expect(document.activeElement).toBe(price);
  });

  it("asks to reload a clean editor, and to load latest when both changed a field", async () => {
    const onLoadLatest = vi.fn();
    await renderEditor(<Editor onLoadLatest={onLoadLatest} />);
    await act(async () => connection.saved(KEY, []));
    await flush();
    expect(document.querySelector("[data-slot=alert]")?.textContent).toContain("Karim Uddin saved: reload to see the changes");
    expect(onLoadLatest).not.toHaveBeenCalled();
    // A save for a revision this editor already has is dropped.
    await act(async () => root.render(<Editor dirty changed={["price"]} onLoadLatest={onLoadLatest} />));
    await act(async () => connection.saved(KEY, ["price"], 10));
    await flush();
    expect(document.querySelector("[data-slot=alert]")?.textContent).toContain("Karim Uddin saved Price, which you changed too");
    expect(onLoadLatest).not.toHaveBeenCalled();
  });
});

describe("list presence", () => {
  function List() {
    const open = useListPresence("order");
    return <RowPresence people={open.get("ord_1")} />;
  }

  it("watches the list and shows who is on a row", async () => {
    await act(async () => root.render(<List />));
    expect(connection.watchList).toHaveBeenCalledWith("order");
    expect(host.textContent).toBe("");
    await act(async () => connection.presence("order:ord_1", [{ id: "usr_rahim", name: "Rahim" }]));
    expect(host.textContent).toContain("Rahim is viewing");
    await act(async () => connection.presence("order:ord_1", [{ id: "usr_rahim", name: "Rahim", editing: true }, { id: "usr_sumi", name: "Sumi" }]));
    expect(host.textContent).toContain("Rahim and 1 other are here");
    await act(async () => connection.presence("order:ord_1", []));
    expect(host.textContent).toBe("");
  });
});

describe("presence helpers", () => {
  it("names fields by form name, never by a generated id", () => {
    const input = document.createElement("input");
    input.id = ":r1:";
    expect(fieldKeyOf(input)).toBeNull();
    input.name = "seo.title";
    expect(fieldKeyOf(input)).toBe("seo.title");
    const holder = document.createElement("div");
    holder.dataset.field = "status";
    const trigger = document.createElement("button");
    holder.appendChild(trigger);
    expect(fieldKeyOf(trigger)).toBe("status");
  });

  it("flattens dirty fields and tells a clean merge from a clash", () => {
    expect(changedFieldNames({ price: true, seo: { title: true }, variants: [{ sku: true }] })).toEqual(["price", "seo.title", "variants.0.sku"]);
    expect(fieldsOverlap(["seo"], ["seo.title"])).toBe(true);
    expect(fieldsOverlap(["price"], ["stock"])).toBe(false);
    const save = { by: { id: "a", name: "A" }, rev: 2, fields: ["price"], at: 1 };
    expect(saveOutcome(save, false, [], true)).toBe("reload");
    expect(saveOutcome(save, true, ["stock"], true)).toBe("merged");
    expect(saveOutcome(save, true, ["price"], true)).toBe("both");
    expect(saveOutcome({ ...save, fields: [] }, true, [], true)).toBe("both");
    expect(saveOutcome(save, true, [], false)).toBe("both");
  });
});
