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
//
// Field presence: a socket reports the field it is in on one of its keys and
// whether it has unsaved changes there (`focus`, rate-limited, never a
// value). The hub keeps the latest report in the attachment and sends it
// inside the key's presence, so a person who arrives late sees the same rings.
import { DurableObject } from "cloudflare:workers";
import {
  MAX_FOCUS_PER_SECOND,
  MAX_SAVED_FIELDS,
  MAX_WATCHED_KEYS,
  PRESENCE_KEY_TOPICS,
  REALTIME_CLOSE_REAUTH,
  REALTIME_PING,
  REALTIME_PONG,
  isFieldKey,
  isPresenceListPrefix,
  isRealtimeTopic,
  presenceKeyPrefix,
  presenceKeyTopic,
  type PresenceListPrefix,
  type RealtimeChange,
  type RealtimePerson,
  type RealtimePresence,
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
  /** Lists that show who has a record open (`order`): presence of every key with the prefix. */
  lists?: PresenceListPrefix[];
  /**
   * What this socket last reported on one of its keys: `i` the key's index in
   * `keys` (the attachment is limited to 2 KB, so the key is not repeated),
   * `f` the focused field, `e` unsaved changes, `at` when (epoch seconds).
   */
  act?: { i: number; f: string | null; e: boolean; at: number };
  /** Focus rate limit: the second of the last accepted report and how many that second. */
  fw?: number;
  fc?: number;
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
    const now = nowSeconds();
    if (state.exp <= now) {
      socket.close(REALTIME_CLOSE_REAUTH, "Authenticate again");
      return;
    }
    let parsed: { t?: unknown; keys?: unknown; lists?: unknown; key?: unknown; rev?: unknown; fields?: unknown; field?: unknown; editing?: unknown };
    try {
      parsed = JSON.parse(message) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.t === "watch" && Array.isArray(parsed.keys)) {
      this.watch(socket, state, parsed.keys, parsed.lists);
      return;
    }
    if (parsed.t === "focus") {
      this.focus(socket, state, now, parsed.key, parsed.field, parsed.editing);
      return;
    }
    if (parsed.t === "saved" && typeof parsed.key === "string" && state.keys.includes(parsed.key)) {
      const rev = typeof parsed.rev === "number" && Number.isSafeInteger(parsed.rev) ? parsed.rev : null;
      const fields = Array.isArray(parsed.fields) ? [...new Set(parsed.fields.filter(isFieldKey))].slice(0, MAX_SAVED_FIELDS) : [];
      const by: RealtimePerson = { id: state.userId, name: state.name };
      const notice: RealtimeServerMessage = { t: "saved", key: parsed.key, by, rev, ...(fields.length > 0 ? { fields } : {}) };
      for (const other of this.ctx.getWebSockets()) {
        if (other === socket) continue;
        const otherState = this.liveState(other, now);
        if (otherState?.keys.includes(parsed.key)) send(other, notice);
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

  /** The editors and lists a socket has open. Keys and lists outside its topics are ignored. */
  private watch(socket: HibernatableWebSocket, state: SocketState, keys: unknown[], lists: unknown): void {
    const topics = new Set(state.topics);
    const next = [...new Set(keys)]
      .filter((key): key is string => {
        const topic = presenceKeyTopic(key);
        return topic !== null && topics.has(topic);
      })
      .slice(0, MAX_WATCHED_KEYS);
    const nextLists = Array.isArray(lists)
      ? [...new Set(lists.filter(isPresenceListPrefix))].filter((prefix) => topics.has(PRESENCE_KEY_TOPICS[prefix]))
      : [];
    const previous = state.keys;
    const previousLists = state.lists ?? [];
    // The reported field stays with its key; a key that closed takes it along.
    const actKey = state.act ? previous[state.act.i] : undefined;
    const actIndex = actKey === undefined ? -1 : next.indexOf(actKey);
    state.keys = next;
    if (nextLists.length > 0) state.lists = nextLists;
    else delete state.lists;
    if (state.act && actIndex >= 0) state.act = { ...state.act, i: actIndex };
    else delete state.act;
    if (!trySerialize(socket, state)) return;
    for (const key of new Set([...previous, ...next])) {
      // A key this socket stayed on has the same watchers: no new frame.
      if (previous.includes(key) && next.includes(key)) continue;
      this.broadcastPresence(key);
    }
    const added = nextLists.filter((prefix) => !previousLists.includes(prefix));
    if (added.length > 0) this.sendListSnapshot(socket, added);
  }

  /** The field a socket is in on one of its keys, and whether it has unsaved changes there. */
  private focus(socket: HibernatableWebSocket, state: SocketState, now: number, key: unknown, field: unknown, editing: unknown): void {
    if (typeof key !== "string" || typeof editing !== "boolean") return;
    if (field !== null && !isFieldKey(field)) return;
    const index = state.keys.indexOf(key);
    if (index < 0) return;
    // Rate limit: a socket that reports too fast is ignored for the rest of the second.
    if (state.fw === now && (state.fc ?? 0) >= MAX_FOCUS_PER_SECOND) return;
    state.fc = state.fw === now ? (state.fc ?? 0) + 1 : 1;
    state.fw = now;
    const previousKey = state.act ? state.keys[state.act.i] : undefined;
    const unchanged = state.act?.i === index && state.act.f === field && state.act.e === editing;
    if (unchanged || (!state.act && field === null && !editing)) {
      trySerialize(socket, state);
      return;
    }
    if (field === null && !editing) delete state.act;
    else state.act = { i: index, f: field, e: editing, at: now };
    if (!trySerialize(socket, state)) return;
    this.broadcastPresence(key);
    if (previousKey !== undefined && previousKey !== key) this.broadcastPresence(previousKey);
  }

  private leave(socket: HibernatableWebSocket): void {
    const state = readState(socket);
    if (!state || state.keys.length === 0) return;
    const keys = state.keys;
    state.keys = [];
    delete state.act;
    delete state.lists;
    // A closed socket may refuse writes; it is excluded below either way.
    trySerialize(socket, state);
    for (const key of keys) this.broadcastPresence(key, socket);
  }

  /**
   * A socket's state while its proof lasts. Past it, the socket hears nothing
   * more (no presence, no save notices: staff names) and is closed, so a
   * revoked session never outlives its proof.
   */
  private liveState(socket: HibernatableWebSocket, now: number): SocketState | null {
    const state = readState(socket);
    if (!state) return null;
    if (state.exp > now) return state;
    socket.close(REALTIME_CLOSE_REAUTH, "Authenticate again");
    return null;
  }

  /**
   * Everyone on `key` hears who is on it (one entry per person, however many
   * tabs). Sockets watching the key's list hear it too, without the field.
   */
  private broadcastPresence(key: string, leaving?: HibernatableWebSocket): void {
    const prefix = presenceKeyPrefix(key);
    const watchers: HibernatableWebSocket[] = [];
    const listeners: HibernatableWebSocket[] = [];
    const states: SocketState[] = [];
    const now = nowSeconds();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === leaving) continue;
      const state = this.liveState(socket, now);
      if (!state) continue;
      if (state.keys.includes(key)) {
        watchers.push(socket);
        states.push(state);
      } else if (prefix && state.lists?.some((list) => list === prefix)) {
        listeners.push(socket);
      }
    }
    const people = presenceOf(key, states);
    for (const socket of watchers) send(socket, { t: "presence", key, people });
    if (listeners.length === 0) return;
    const summary = withoutFields(people);
    for (const socket of listeners) send(socket, { t: "presence", key, people: summary });
  }

  /** A socket that starts watching a list hears who has each of its records open now. */
  private sendListSnapshot(socket: HibernatableWebSocket, prefixes: readonly PresenceListPrefix[]): void {
    const now = nowSeconds();
    const byKey = new Map<string, SocketState[]>();
    for (const other of this.ctx.getWebSockets()) {
      const state = this.liveState(other, now);
      if (!state) continue;
      for (const key of state.keys) {
        const prefix = presenceKeyPrefix(key);
        if (!prefix || !prefixes.some((list) => list === prefix)) continue;
        byKey.set(key, [...(byKey.get(key) ?? []), state]);
      }
    }
    for (const [key, states] of byKey) send(socket, { t: "presence", key, people: withoutFields(presenceOf(key, states)) });
  }
}

function trySerialize(socket: HibernatableWebSocket, state: SocketState): boolean {
  try {
    socket.serializeAttachment(state);
    return true;
  } catch {
    // Over the attachment's size limit, or a closed socket: the change is dropped.
    return false;
  }
}

function withoutFields(people: readonly RealtimePresence[]): RealtimePresence[] {
  return people.map(({ field: _field, ...person }) => person);
}

/**
 * The people on `key` from the states of its sockets: one entry per person,
 * sorted by id so every watcher sees the same order. A person is editing when
 * any of their tabs is; their field is the one they reported last.
 */
export function presenceOf(key: string, states: readonly SocketState[]): RealtimePresence[] {
  const people = new Map<string, RealtimePresence & { at: number }>();
  for (const state of states) {
    const act = state.act && state.keys[state.act.i] === key ? state.act : null;
    const entry = people.get(state.userId) ?? { id: state.userId, name: state.name, at: -1 };
    if (act && (act.e || act.f)) entry.editing = true;
    if (act?.f && act.at >= entry.at) {
      entry.field = act.f;
      entry.at = act.at;
    }
    people.set(state.userId, entry);
  }
  return [...people.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ at: _at, ...person }) => person);
}

export type { SocketState as RealtimeSocketState };
