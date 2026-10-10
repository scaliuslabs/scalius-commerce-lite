// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireRealtimeConnection, RealtimeConnection } from "./connection";

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  message(data: unknown) {
    this.emit("message", { data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

describe("RealtimeConnection", () => {
  let connection: RealtimeConnection;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    connection = new RealtimeConnection({
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      url: () => "wss://admin.shop.test/api/realtime",
      random: () => 1,
    });
  });

  afterEach(() => {
    connection.stop();
    vi.useRealTimers();
  });

  it("delivers notices, sends the editors it watches, and resyncs after a gap", () => {
    const changes = vi.fn();
    const resync = vi.fn();
    connection.subscribe({ changes, resync });
    connection.start();
    const first = FakeSocket.all[0]!;
    first.open();
    const release = connection.watch("product:prd_1");
    expect(first.sent.at(-1)).toBe(JSON.stringify({ t: "watch", keys: ["product:prd_1"] }));

    first.message({ t: "changes", items: [{ topic: "orders", kind: "order.created", id: "ord_1" }] });
    expect(changes).toHaveBeenCalledWith([{ topic: "orders", kind: "order.created", id: "ord_1" }]);
    expect(resync).not.toHaveBeenCalled();

    // The socket drops: back off (1 s step, full jitter here), reconnect, resend keys, resync.
    first.emit("close", { code: 1006 });
    vi.advanceTimersByTime(1_000);
    const second = FakeSocket.all[1]!;
    second.open();
    expect(second.sent[0]).toBe(JSON.stringify({ t: "watch", keys: ["product:prd_1"] }));
    expect(resync).toHaveBeenCalledTimes(1);

    release();
    expect(second.sent.at(-1)).toBe(JSON.stringify({ t: "watch", keys: [] }));
  });

  it("coalesces focus reports, resends them after a reconnect, and sends lists and saved fields", () => {
    const saved = vi.fn();
    connection.subscribe({ saved });
    connection.start();
    const first = FakeSocket.all[0]!;
    first.open();
    first.sent = [];
    // A key that is not watched reports nothing.
    connection.focus("product:prd_1", "price", false);
    expect(first.sent).toEqual([]);
    const release = connection.watch("product:prd_1");
    const releaseList = connection.watchList("order");
    expect(first.sent.at(-1)).toBe(JSON.stringify({ t: "watch", keys: ["product:prd_1"], lists: ["order"] }));
    first.sent = [];

    // The first report goes at once; a burst inside 200 ms ends on its last state.
    connection.focus("product:prd_1", "price", false);
    connection.focus("product:prd_1", "stock", false);
    connection.focus("product:prd_1", "stock", true);
    expect(first.sent).toEqual([JSON.stringify({ t: "focus", key: "product:prd_1", field: "price", editing: false })]);
    vi.advanceTimersByTime(200);
    expect(first.sent.at(-1)).toBe(JSON.stringify({ t: "focus", key: "product:prd_1", field: "stock", editing: true }));
    vi.advanceTimersByTime(1_000);
    expect(first.sent).toHaveLength(2);

    // A new socket hears the state again.
    first.emit("close", { code: 1006 });
    vi.advanceTimersByTime(1_000);
    const second = FakeSocket.all[1]!;
    second.open();
    expect(second.sent).toEqual([
      JSON.stringify({ t: "watch", keys: ["product:prd_1"], lists: ["order"] }),
      JSON.stringify({ t: "focus", key: "product:prd_1", field: "stock", editing: true }),
    ]);

    connection.announceSave("product:prd_1", 4, ["price"]);
    expect(second.sent.at(-1)).toBe(JSON.stringify({ t: "saved", key: "product:prd_1", rev: 4, fields: ["price"] }));
    second.message({ t: "saved", key: "product:prd_1", by: { id: "usr_k", name: "Karim" }, rev: 5, fields: ["stock"] });
    expect(saved).toHaveBeenCalledWith("product:prd_1", { id: "usr_k", name: "Karim" }, 5, ["stock"]);
    second.message({ t: "saved", key: "product:prd_1", by: { id: "usr_k", name: "Karim" }, rev: 6 });
    expect(saved).toHaveBeenLastCalledWith("product:prd_1", { id: "usr_k", name: "Karim" }, 6, []);

    releaseList();
    release();
    expect(second.sent.at(-1)).toBe(JSON.stringify({ t: "watch", keys: [] }));
  });

  it("detects a dead socket after sleep: no pong within 10 s reconnects at once", () => {
    connection.start();
    const first = FakeSocket.all[0]!;
    first.open();
    vi.advanceTimersByTime(45_000);
    expect(first.sent).toContain("ping");
    vi.advanceTimersByTime(10_000);
    expect(first.closedWith).toBe(4000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("a pong keeps the socket", () => {
    connection.start();
    const first = FakeSocket.all[0]!;
    first.open();
    vi.advanceTimersByTime(45_000);
    first.message("pong");
    vi.advanceTimersByTime(10_000);
    expect(first.closedWith).toBeNull();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("backs off longer after repeated refusals and reconnects when the browser is back online", () => {
    connection.start();
    FakeSocket.all[0]!.emit("close", { code: 1006 });
    vi.advanceTimersByTime(1_000);
    FakeSocket.all[1]!.emit("close", { code: 1006 });
    vi.advanceTimersByTime(2_000);
    expect(FakeSocket.all).toHaveLength(3);
    // The third refusal in a row waits the longest step (signed out, no access).
    FakeSocket.all[2]!.emit("close", { code: 1006 });
    vi.advanceTimersByTime(29_000);
    expect(FakeSocket.all).toHaveLength(3);
    window.dispatchEvent(new Event("online"));
    expect(FakeSocket.all).toHaveLength(4);
  });
});

describe("acquireRealtimeConnection: one socket per tab", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
  });
  afterEach(() => vi.useRealTimers());

  const create = () => new RealtimeConnection({
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    url: () => "wss://admin.shop.test/api/realtime",
    random: () => 1,
  });

  it("a remount (StrictMode replay, a layout switch) takes the same socket over", () => {
    const first = acquireRealtimeConnection("usr_1", create);
    first.release();
    const second = acquireRealtimeConnection("usr_1", create);
    vi.advanceTimersByTime(0);
    expect(second.connection).toBe(first.connection);
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0]!.closedWith).toBeNull();
    // Two holders at once share it too.
    const third = acquireRealtimeConnection("usr_1", create);
    expect(third.connection).toBe(first.connection);
    second.release();
    third.release();
    vi.advanceTimersByTime(0);
    expect(FakeSocket.all[0]!.closedWith).toBe(1000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("another user or other permissions replace the socket", () => {
    const first = acquireRealtimeConnection("usr_1", create);
    const other = acquireRealtimeConnection("usr_2", create);
    expect(other.connection).not.toBe(first.connection);
    expect(FakeSocket.all[0]!.closedWith).toBe(1000);
    expect(FakeSocket.all).toHaveLength(2);
    first.release();
    vi.advanceTimersByTime(0);
    expect(FakeSocket.all[1]!.closedWith).toBeNull();
    other.release();
    vi.advanceTimersByTime(0);
  });

  it("never holds two sockets while one is still opening", () => {
    const { connection, release } = acquireRealtimeConnection("usr_3", create);
    // The pong timeout path and a wake can both ask to open: the opening socket is dropped first.
    (connection as unknown as { open(): void }).open();
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[0]!.closedWith).toBe(1000);
    release();
    vi.advanceTimersByTime(0);
  });
});
