// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeConnection } from "./connection";

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
