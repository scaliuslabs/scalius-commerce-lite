// The realtime hub (docs/platform/REALTIME.md): one SQLite-backed Durable
// Object per store that fans change notices, presence and save notices out to
// staff dashboards. It keeps no business state and uses no storage: the
// relational database is the authority, and everything a socket needs
// (who it is, what it may hear, which editors it has open) is the socket's
// own attachment, which survives hibernation.
//
// Sockets are hibernatable (`ctx.acceptWebSocket`), so an idle dashboard costs
// no duration; `ping` is answered by the auto-response without waking the
// object. Each socket is tagged with its user only (the runtime allows at
// most 10 tags a socket, fewer than the topics an owner hears); a notice
// reaches only the sockets whose attachment's topics allow it. A store has
// few sockets, so scanning them is cheap.
import { DurableObject } from "cloudflare:workers";
import {
  MAX_WATCHED_KEYS,
  REALTIME_CLOSE_REAUTH,
  REALTIME_PING,
  REALTIME_PONG,
  isRealtimeTopic,
  presenceKeyTopic,
  type RealtimeChange,
  type RealtimePerson,
  type RealtimeServerMessage,
  type RealtimeTopic,
} from "@scalius/shared/realtime";

/** The identity the API Worker proved before it forwarded the upgrade. */
export interface RealtimeIdentity {
  userId: string;
  name: string;
  topics: RealtimeTopic[];
}

/** Header the API Worker sets on the internal upgrade request (the hub is reachable only through its binding). */
export const REALTIME_IDENTITY_HEADER = "X-Scalius-Realtime-Identity";

/**
 * How long a socket's proof lasts. The hub never re-reads the database: past
 * this, the next notice for the socket closes it instead, and the client
 * reconnects through the session and permission check again.
 */
export const REALTIME_PROOF_SECONDS = 15 * 60;
/** Sockets one staff member may hold (tabs); the oldest closes first. */
export const MAX_SOCKETS_PER_USER = 12;
/** Changes in one notice frame. More coalesce into one `changed` per topic. */
const MAX_CHANGES_PER_FRAME = 50;
const MAX_NAME_LENGTH = 80;
const MAX_CLIENT_MESSAGE_BYTES = 2_048;

interface SocketState {
  userId: string;
  name: string;
  topics: RealtimeTopic[];
  /** Epoch seconds after which the socket must authenticate again. */
  exp: number;
  /** Editors this socket has open (presence keys). */
  keys: string[];
}

function userTag(userId: string): string {
  return `u:${userId}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function readState(socket: HibernatableWebSocket): SocketState | null {
  try {
    const value = socket.deserializeAttachment() as SocketState | null;
    return value && typeof value.userId === "string" ? value : null;
  } catch {
    return null;
  }
}

function send(socket: HibernatableWebSocket, message: RealtimeServerMessage): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // A closing socket: its close handler cleans up.
  }
}

export function parseIdentity(raw: string | null): RealtimeIdentity | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RealtimeIdentity>;
    if (typeof value.userId !== "string" || value.userId.length === 0 || value.userId.length > 128) return null;
    if (!Array.isArray(value.topics)) return null;
    const name = typeof value.name === "string" ? value.name.slice(0, MAX_NAME_LENGTH) : "";
    return { userId: value.userId, name, topics: value.topics.filter(isRealtimeTopic) };
  } catch {
    return null;
  }
}

/**
 * Changes for one socket: those of its topics, at most one frame. A burst
 * beyond the frame collapses to one table-level `changed` per topic, which the
 * dashboard treats as "refetch that topic".
 */
export function framesFor(topics: ReadonlySet<string>, changes: readonly RealtimeChange[]): RealtimeChange[] {
  const mine = changes.filter((change) => topics.has(change.topic));
  if (mine.length <= MAX_CHANGES_PER_FRAME) return mine;
  return [...new Set(mine.map((change) => change.topic))].map((topic) => ({ topic, kind: "changed" }));
}

export class RealtimeHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime while the object sleeps: keeps NATs and the
    // client's liveness check happy at no duration cost.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(REALTIME_PING, REALTIME_PONG));
  }

  /** The upgrade, forwarded by the API Worker after it checked the staff session (realtime/connect.ts). */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const identity = parseIdentity(request.headers.get(REALTIME_IDENTITY_HEADER));
    if (!identity) return new Response("Forbidden", { status: 403 });

    const existing = this.ctx.getWebSockets(userTag(identity.userId));
    for (const stale of existing.slice(0, Math.max(0, existing.length - MAX_SOCKETS_PER_USER + 1))) {
      stale.close(1008, "Too many tabs");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // One tag, whatever the topic count: the runtime refuses more than 10.
    this.ctx.acceptWebSocket(server, [userTag(identity.userId)]);
    const state: SocketState = {
      userId: identity.userId,
      name: identity.name,
      topics: identity.topics,
      exp: nowSeconds() + REALTIME_PROOF_SECONDS,
      keys: [],
    };
    server.serializeAttachment(state);
    send(server, { t: "hello", userId: identity.userId, topics: identity.topics });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** RPC from the API Worker: change notices from the event outbox flush and from writes. */
  async publish(changes: RealtimeChange[]): Promise<{ sockets: number }> {
    if (!Array.isArray(changes) || changes.length === 0) return { sockets: 0 };
    const topics = new Set<string>(changes.map((change) => change.topic));
    const now = nowSeconds();
    let sockets = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const state = readState(socket);
      if (!state || !state.topics.some((topic) => topics.has(topic))) continue;
      if (state.exp <= now) {
        socket.close(REALTIME_CLOSE_REAUTH, "Authenticate again");
        continue;
      }
      const items = framesFor(new Set(state.topics), changes);
      if (items.length === 0) continue;
      send(socket, { t: "changes", items });
      sockets += 1;
    }
    return { sockets };
  }

  /** RPC: the staff members with an open dashboard (Web Push skips them; agents may read it). */
  async online(): Promise<string[]> {
    const now = nowSeconds();
    const users = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      const state = readState(socket);
      if (state && state.exp > now) users.add(state.userId);
    }
    return [...users];
  }

  async webSocketMessage(socket: HibernatableWebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > MAX_CLIENT_MESSAGE_BYTES) return;
    const state = readState(socket);
    if (!state) return;
    if (state.exp <= nowSeconds()) {
      socket.close(REALTIME_CLOSE_REAUTH, "Authenticate again");
      return;
    }
    let parsed: { t?: unknown; keys?: unknown; key?: unknown; rev?: unknown };
    try {
      parsed = JSON.parse(message) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.t === "watch" && Array.isArray(parsed.keys)) {
      const topics = new Set(state.topics);
      const next = [...new Set(parsed.keys)]
        .filter((key): key is string => {
          const topic = presenceKeyTopic(key);
          return topic !== null && topics.has(topic);
        })
        .slice(0, MAX_WATCHED_KEYS);
      const previous = state.keys;
      state.keys = next;
      socket.serializeAttachment(state);
      const touched = new Set([...previous, ...next]);
      for (const key of touched) this.broadcastPresence(key);
      return;
    }
    if (parsed.t === "saved" && typeof parsed.key === "string" && state.keys.includes(parsed.key)) {
      const rev = typeof parsed.rev === "number" && Number.isSafeInteger(parsed.rev) ? parsed.rev : null;
      const by: RealtimePerson = { id: state.userId, name: state.name };
      for (const other of this.ctx.getWebSockets()) {
        if (other === socket) continue;
        const otherState = readState(other);
        if (otherState?.keys.includes(parsed.key)) send(other, { t: "saved", key: parsed.key, by, rev });
      }
    }
  }

  async webSocketClose(socket: HibernatableWebSocket, code: number, reason: string): Promise<void> {
    this.leave(socket);
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(socket: HibernatableWebSocket): Promise<void> {
    this.leave(socket);
  }

  private leave(socket: HibernatableWebSocket): void {
    const state = readState(socket);
    if (!state || state.keys.length === 0) return;
    const keys = state.keys;
    state.keys = [];
    try {
      socket.serializeAttachment(state);
    } catch {
      // A closed socket may refuse writes; it is excluded below either way.
    }
    for (const key of keys) this.broadcastPresence(key, socket);
  }

  /** Everyone on `key` hears who is on it (one entry per person, however many tabs). */
  private broadcastPresence(key: string, leaving?: HibernatableWebSocket): void {
    const watchers: Array<{ socket: HibernatableWebSocket; state: SocketState }> = [];
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === leaving) continue;
      const state = readState(socket);
      if (state?.keys.includes(key)) watchers.push({ socket, state });
    }
    const people = new Map<string, RealtimePerson>();
    for (const { state } of watchers) people.set(state.userId, { id: state.userId, name: state.name });
    // Sorted, so every watcher sees the same order however the runtime lists sockets.
    const list = [...people.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const { socket } of watchers) send(socket, { t: "presence", key, people: list });
  }
}
