// The realtime hub in workerd (Miniflare): real hibernatable WebSockets, tags,
// attachments and the ping auto-response. The harness Worker stands in for
// realtime/connect.ts, which is covered in connect.test.ts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RealtimeServerMessage } from "@scalius/shared/realtime";

const apiDir = resolve(import.meta.dirname, "../..");
const HARNESS = resolve(import.meta.dirname, "../testing/realtime-hub-harness.worker.ts");
const COMPATIBILITY_DATE = "2026-07-30";

interface Client {
  messages: unknown[];
  socket: { send(data: string): void; close(code?: number): void; accept(): void; addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void): void };
  closed: Promise<number>;
  next(predicate: (message: RealtimeServerMessage) => boolean): Promise<RealtimeServerMessage>;
}

describe("RealtimeHub in workerd", () => {
  let mf: Miniflare;
  let workdir: string;

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), "scalius-realtime-hub-"));
    writeFileSync(join(workdir, "wrangler.json"), JSON.stringify({
      name: "realtime-hub-harness",
      main: HARNESS,
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: ["nodejs_compat"],
    }));
    execFileSync(join(apiDir, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", join(workdir, "dist"), "--config", join(workdir, "wrangler.json")], {
      cwd: apiDir,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    mf = new Miniflare(convertV4MiniflareOptions({
      modules: true,
      scriptPath: join(workdir, "dist", "realtime-hub-harness.worker.js"),
      modulesRoot: join(workdir, "dist"),
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { REALTIME_HUB: { className: "RealtimeHub", useSQLite: true } },
    }) as never);
  }, 120_000);

  afterAll(async () => {
    await mf?.dispose();
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  });

  async function connect(userId: string, name: string, topics: string[]): Promise<Client> {
    const identity = encodeURIComponent(JSON.stringify({ userId, name, topics }));
    const response = await mf.dispatchFetch(`http://hub/connect?identity=${identity}`, { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(101);
    const socket = response.webSocket as unknown as Client["socket"];
    const messages: unknown[] = [];
    const waiters: Array<{ predicate: (message: RealtimeServerMessage) => boolean; resolve: (message: RealtimeServerMessage) => void }> = [];
    let closedResolve: (code: number) => void = () => undefined;
    const closed = new Promise<number>((resolve) => { closedResolve = resolve; });
    socket.addEventListener("message", (event) => {
      const text = String(event.data);
      const message = text === "pong" ? text : JSON.parse(text);
      const waiter = typeof message === "object" ? waiters.find((candidate) => candidate.predicate(message as RealtimeServerMessage)) : undefined;
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message as RealtimeServerMessage);
        return;
      }
      messages.push(message);
    });
    socket.addEventListener("close", (event) => closedResolve(event.code ?? 0));
    socket.accept();
    const next = (predicate: (message: RealtimeServerMessage) => boolean) => {
      const seen = messages.find((message) => typeof message === "object" && predicate(message as RealtimeServerMessage));
      if (seen) {
        messages.splice(messages.indexOf(seen), 1);
        return Promise.resolve(seen as RealtimeServerMessage);
      }
      return new Promise<RealtimeServerMessage>((resolve) => waiters.push({ predicate, resolve }));
    };
    return { messages, socket, closed, next };
  }

  const publish = async (changes: unknown[]) => (await mf.dispatchFetch("http://hub/publish", { method: "POST", body: JSON.stringify(changes) })).json();

  it("greets, fans out notices by topic, answers ping and tracks presence and saves", async () => {
    const rahim = await connect("usr_rahim", "Rahim", ["orders", "products", "inbox"]);
    const karim = await connect("usr_karim", "Karim", ["products"]);
    expect(await rahim.next((message) => message.t === "hello")).toEqual({ t: "hello", userId: "usr_rahim", topics: ["orders", "products", "inbox"] });
    await karim.next((message) => message.t === "hello");

    // Orders reach only the socket allowed to hear them.
    expect(await publish([
      { topic: "orders", kind: "order.created", id: "ord_1", status: "pending" },
      { topic: "products", kind: "product.updated", id: "prd_1", rev: 4 },
    ])).toEqual({ sockets: 2 });
    expect(await rahim.next((message) => message.t === "changes")).toEqual({ t: "changes", items: [
      { topic: "orders", kind: "order.created", id: "ord_1", status: "pending" },
      { topic: "products", kind: "product.updated", id: "prd_1", rev: 4 },
    ] });
    expect(await karim.next((message) => message.t === "changes")).toEqual({ t: "changes", items: [
      { topic: "products", kind: "product.updated", id: "prd_1", rev: 4 },
    ] });

    // The auto-response answers without waking the object.
    rahim.socket.send("ping");
    await expect.poll(() => rahim.messages.includes("pong")).toBe(true);

    // Presence: both open the same product; a key outside the socket's topics is ignored.
    rahim.socket.send(JSON.stringify({ t: "watch", keys: ["product:prd_1", "settings:checkout"] }));
    expect(await rahim.next((message) => message.t === "presence")).toEqual({ t: "presence", key: "product:prd_1", people: [{ id: "usr_rahim", name: "Rahim" }] });
    karim.socket.send(JSON.stringify({ t: "watch", keys: ["product:prd_1"] }));
    const both = { t: "presence", key: "product:prd_1", people: [{ id: "usr_karim", name: "Karim" }, { id: "usr_rahim", name: "Rahim" }] };
    expect(await karim.next((message) => message.t === "presence")).toEqual(both);
    expect(await rahim.next((message) => message.t === "presence")).toEqual(both);

    // A save notice reaches the other editor at once, never the saver.
    karim.socket.send(JSON.stringify({ t: "saved", key: "product:prd_1", rev: 5 }));
    expect(await rahim.next((message) => message.t === "saved")).toEqual({ t: "saved", key: "product:prd_1", by: { id: "usr_karim", name: "Karim" }, rev: 5 });

    expect(new Set(await (await mf.dispatchFetch("http://hub/online")).json() as string[])).toEqual(new Set(["usr_rahim", "usr_karim"]));

    // Leaving tells the others.
    karim.socket.close(1000);
    expect(await rahim.next((message) => message.t === "presence")).toEqual({ t: "presence", key: "product:prd_1", people: [{ id: "usr_rahim", name: "Rahim" }] });
    rahim.socket.close(1000);
  }, 60_000);

  it("refuses an upgrade without a proven identity", async () => {
    const response = await mf.dispatchFetch("http://hub/connect", { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(403);
  });
});
