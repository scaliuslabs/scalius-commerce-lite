// The hub's proof window in-process (the workerd test cannot move time): a
// socket past its 15-minute proof hears no presence and no save notices (staff
// names) and is closed, so a revoked session never outlives its proof.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REALTIME_CLOSE_REAUTH } from "@scalius/shared/realtime";
import { REALTIME_PROOF_SECONDS, RealtimeHub } from "./hub";

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
    socket.serializeAttachment({ userId, name: userId, topics: ["products"], exp, keys });
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
