// The hub's proof window in-process (the workerd test cannot move time): a
// socket past its 15-minute proof hears no presence and no save notices (staff
// names) and is closed, so a revoked session never outlives its proof.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_FOCUS_PER_SECOND,
  MAX_SAVED_FIELDS,
  MAX_WATCHED_KEYS,
  PRESENCE_LIST_PREFIXES,
  PRESENCE_PREFIXES,
  REALTIME_CLOSE_REAUTH,
  REALTIME_TOPICS,
  presenceEditMask,
} from "@scalius/shared/realtime";
import { REALTIME_PROOF_SECONDS, RealtimeHub, presenceOf } from "./hub";

class FakeSocket {
  attachment: unknown = null;
  sent: unknown[] = [];
  closedWith: number | null = null;
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code: number) {
    this.closedWith = code;
  }
}

describe("RealtimeHub proof window", () => {
  let sockets: FakeSocket[];
  let hub: RealtimeHub;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-08T10:00:00Z") });
    vi.stubGlobal("WebSocketRequestResponsePair", class {});
    sockets = [];
    const ctx = {
      setWebSocketAutoResponse() {},
      getWebSockets: () => sockets,
    };
    hub = new RealtimeHub(ctx as never, {} as Env);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function join(userId: string, exp: number, keys: string[]) {
    const socket = new FakeSocket();
    socket.serializeAttachment({ userId, name: userId, topics: ["products"], w: (1 << PRESENCE_PREFIXES.length) - 1, exp, keys });
    sockets.push(socket);
    return socket;
  }

  it("an expired socket hears no presence or save notice and is closed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = join("usr_revoked", now - 1, ["product:prd_1"]);
    const live = join("usr_live", now + REALTIME_PROOF_SECONDS, []);
    const saver = join("usr_saver", now + REALTIME_PROOF_SECONDS, ["product:prd_1"]);

    await hub.webSocketMessage(live as never, JSON.stringify({ t: "watch", keys: ["product:prd_1"] }));
    // Presence lists only people whose proof lasts; the expired socket is told nothing.
    expect(live.sent.at(-1)).toEqual({ t: "presence", key: "product:prd_1", people: [{ id: "usr_live", name: "usr_live" }, { id: "usr_saver", name: "usr_saver" }] });
    expect(stale.sent).toEqual([]);
    expect(stale.closedWith).toBe(REALTIME_CLOSE_REAUTH);

    stale.closedWith = null;
    await hub.webSocketMessage(saver as never, JSON.stringify({ t: "saved", key: "product:prd_1", rev: 3 }));
    expect(live.sent.at(-1)).toEqual({ t: "saved", key: "product:prd_1", by: { id: "usr_saver", name: "usr_saver" }, rev: 3 });
    expect(stale.sent).toEqual([]);
    expect(stale.closedWith).toBe(REALTIME_CLOSE_REAUTH);
  });
});

describe("RealtimeHub field presence, lists and save fields", () => {
  let sockets: FakeSocket[];
  let hub: RealtimeHub;
  const now = () => Math.floor(Date.now() / 1000);

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-08T10:00:00Z") });
    vi.stubGlobal("WebSocketRequestResponsePair", class {});
    sockets = [];
    hub = new RealtimeHub({ setWebSocketAutoResponse() {}, getWebSockets: () => sockets } as never, {} as Env);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function connect(userId: string, topics: string[], w: number | undefined = (1 << PRESENCE_PREFIXES.length) - 1) {
    const socket = new FakeSocket();
    socket.serializeAttachment({ userId, name: userId.replace("usr_", ""), topics, w, exp: now() + REALTIME_PROOF_SECONDS, keys: [] });
    sockets.push(socket);
    return socket;
  }
  const say = (socket: FakeSocket, message: unknown) => hub.webSocketMessage(socket as never, JSON.stringify(message));

  it("lets viewers watch while refusing their field and save hints, including legacy attachments", async () => {
    const editor = connect("usr_editor", ["customers", "discounts", "gift_cards"]);
    const viewer = connect("usr_viewer", ["customers", "discounts", "gift_cards"], 0);
    const legacy = connect("usr_legacy", ["customers"], 0);
    const attachment = legacy.deserializeAttachment() as Record<string, unknown>;
    delete attachment.w;
    legacy.serializeAttachment(attachment);
    await say(editor, { t: "watch", keys: ["customer:cus_1"] });
    for (const socket of [viewer, legacy]) {
      await say(socket, { t: "watch", keys: ["customer:cus_1", "product:prd_forbidden"] });
      expect((socket.deserializeAttachment() as { keys: string[] }).keys).toEqual(["customer:cus_1"]);
      const before = editor.sent.length;
      await say(socket, { t: "focus", key: "customer:cus_1", field: "name", editing: true });
      await say(socket, { t: "saved", key: "customer:cus_1", rev: null, fields: ["name"] });
      expect(editor.sent.length).toBe(before);
      expect((socket.deserializeAttachment() as { act?: unknown }).act).toBeUndefined();
    }
    await say(editor, { t: "saved", key: "customer:cus_1", rev: null });
    expect(viewer.sent.at(-1)).toMatchObject({ t: "saved", key: "customer:cus_1", rev: null });
  });

  it("treats conversations as viewing even for staff who can reply", async () => {
    const sender = connect("usr_sender", ["inbox"], presenceEditMask(["conversations.view", "conversations.reply"]));
    const viewer = connect("usr_viewer", ["inbox"], 0);
    for (const socket of [sender, viewer]) await say(socket, { t: "watch", keys: ["conversation:cnv_1"] });
    const before = viewer.sent.length;
    await say(sender, { t: "focus", key: "conversation:cnv_1", field: "body", editing: true });
    await say(sender, { t: "saved", key: "conversation:cnv_1", rev: 4 });
    expect(viewer.sent.length).toBe(before);
    expect(viewer.sent.at(-1)).toMatchObject({ people: [{ id: "usr_sender", name: "sender" }, { id: "usr_viewer", name: "viewer" }] });
  });

  it("sends the focused field and editing state inside presence, never a value", async () => {
    const rahim = connect("usr_rahim", ["products"]);
    const karim = connect("usr_karim", ["products"]);
    await say(rahim, { t: "watch", keys: ["product:prd_1"] });
    await say(karim, { t: "watch", keys: ["product:prd_1"] });
    await say(rahim, { t: "focus", key: "product:prd_1", field: "price", editing: false });
    expect(karim.sent.at(-1)).toEqual({ t: "presence", key: "product:prd_1", people: [
      { id: "usr_karim", name: "karim" },
      { id: "usr_rahim", name: "rahim", editing: true, field: "price" },
    ] });
    // Leaving the field with unsaved changes keeps "editing" and drops the ring.
    await say(rahim, { t: "focus", key: "product:prd_1", field: null, editing: true });
    expect(karim.sent.at(-1)).toEqual({ t: "presence", key: "product:prd_1", people: [
      { id: "usr_karim", name: "karim" },
      { id: "usr_rahim", name: "rahim", editing: true },
    ] });
    // Nothing changed: no frame.
    const before = karim.sent.length;
    await say(rahim, { t: "focus", key: "product:prd_1", field: null, editing: true });
    expect(karim.sent.length).toBe(before);
    // A generated id, a value-shaped field or a key the socket does not watch is ignored.
    await say(rahim, { t: "focus", key: "product:prd_1", field: ":r1:", editing: true });
    await say(rahim, { t: "focus", key: "product:prd_1", field: "৳ 1200", editing: true });
    await say(rahim, { t: "focus", key: "product:prd_2", field: "price", editing: true });
    expect(karim.sent.length).toBe(before);
    // A person who arrives late sees the same state.
    const late = connect("usr_late", ["products"]);
    await say(late, { t: "watch", keys: ["product:prd_1"] });
    expect(late.sent.at(-1)).toEqual({ t: "presence", key: "product:prd_1", people: [
      { id: "usr_karim", name: "karim" },
      { id: "usr_late", name: "late" },
      { id: "usr_rahim", name: "rahim", editing: true },
    ] });
  });

  it("rate-limits focus reports per socket", async () => {
    const rahim = connect("usr_rahim", ["products"]);
    const karim = connect("usr_karim", ["products"]);
    await say(rahim, { t: "watch", keys: ["product:prd_1"] });
    await say(karim, { t: "watch", keys: ["product:prd_1"] });
    const before = karim.sent.length;
    for (let index = 0; index < 20; index += 1) {
      await say(rahim, { t: "focus", key: "product:prd_1", field: `field${index}`, editing: false });
    }
    expect(karim.sent.length - before).toBe(MAX_FOCUS_PER_SECOND);
    vi.advanceTimersByTime(1_000);
    await say(rahim, { t: "focus", key: "product:prd_1", field: "price", editing: false });
    expect(karim.sent.length - before).toBe(MAX_FOCUS_PER_SECOND + 1);
  });

  it("tells list watchers who has a record open, without the field, and only with the topic", async () => {
    const clerk = connect("usr_clerk", ["orders"]);
    const writer = connect("usr_writer", ["products"]);
    const rahim = connect("usr_rahim", ["orders"]);
    await say(rahim, { t: "watch", keys: ["order:ord_1"] });
    await say(rahim, { t: "focus", key: "order:ord_1", field: "note", editing: true });
    // Joining the list gives a snapshot of the open orders.
    await say(clerk, { t: "watch", keys: [], lists: ["order"] });
    expect(clerk.sent).toEqual([{ t: "presence", key: "order:ord_1", people: [{ id: "usr_rahim", name: "rahim", editing: true }] }]);
    // A socket without the orders topic cannot watch the order list.
    await say(writer, { t: "watch", keys: [], lists: ["order", "nope"] });
    expect(writer.sent).toEqual([]);
    // Leaving reaches the list.
    await say(rahim, { t: "watch", keys: [] });
    expect(clerk.sent.at(-1)).toEqual({ t: "presence", key: "order:ord_1", people: [] });
    expect(writer.sent).toEqual([]);
  });

  it("forwards the saved field keys, checked and capped", async () => {
    const rahim = connect("usr_rahim", ["products"]);
    const karim = connect("usr_karim", ["products"]);
    await say(rahim, { t: "watch", keys: ["product:prd_1"] });
    await say(karim, { t: "watch", keys: ["product:prd_1"] });
    const fields = ["price", "price", "stock", "<b>", ...Array.from({ length: 30 }, (_, index) => `f${index}`)];
    await say(rahim, { t: "saved", key: "product:prd_1", rev: 7, fields });
    const notice = karim.sent.at(-1) as { fields: string[] };
    expect(notice).toMatchObject({ t: "saved", key: "product:prd_1", by: { id: "usr_rahim", name: "rahim" }, rev: 7 });
    expect(notice.fields.slice(0, 3)).toEqual(["price", "stock", "f0"]);
    expect(notice.fields).toHaveLength(MAX_SAVED_FIELDS);
    await say(rahim, { t: "saved", key: "product:prd_1", rev: 8 });
    expect(karim.sent.at(-1)).toEqual({ t: "saved", key: "product:prd_1", by: { id: "usr_rahim", name: "rahim" }, rev: 8 });
  });

  it("keeps the worst-case attachment under the runtime's 2 KB limit", () => {
    const keys = Array.from({ length: MAX_WATCHED_KEYS }, (_, index) => `purchase-order:${"c".repeat(78)}${String(index).padStart(2, "0")}`);
    const state = {
      userId: "u".repeat(128),
      name: "র".repeat(80),
      topics: [...REALTIME_TOPICS],
      w: (1 << PRESENCE_PREFIXES.length) - 1,
      exp: now(),
      keys,
      lists: [...PRESENCE_LIST_PREFIXES],
      act: { i: 11, f: "f".repeat(80), e: true, at: now() },
      fw: now(),
      fc: MAX_FOCUS_PER_SECOND,
    };
    // V8 stores the Bangla name two bytes a character; JSON's UTF-8 is the larger bound.
    expect(new TextEncoder().encode(JSON.stringify(state)).length).toBeLessThan(2_048);
    expect(presenceOf(keys[11]!, [state])).toEqual([{ id: state.userId, name: state.name, editing: true, field: "f".repeat(80) }]);
  });
});
