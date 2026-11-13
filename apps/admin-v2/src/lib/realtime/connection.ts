/**
 * The dashboard's one WebSocket to the store's realtime hub
 * (docs/platform/REALTIME.md). Small on purpose: it loads lazily with the
 * admin frame (components/admin/realtime/RealtimeBridge.tsx).
 *
 * - One socket per browser, not per tab: the tab holding the Web Lock opens
 *   it and relays to the others over a BroadcastChannel (`SharedRealtimeConnection`),
 *   so tabs never compete for the hub's per-person sockets. Without both APIs
 *   each tab has its own.
 * - Reconnects with backoff and jitter (1 s doubling to 30 s), at once when
 *   the browser comes back online or the tab becomes visible.
 * - Every open, the first included, reports `resync`: the page loaded before
 *   the socket opened, and a gap (offline, sleep, a hub restart) may hide
 *   changes too, so the bridge refetches what the screen shows.
 * - A `ping` every 45 s is answered by the hub's auto-response without waking
 *   it; no `pong` within 10 s means a dead socket (a laptop that slept), so it
 *   reconnects.
 * - Editors register presence keys; the set is sent again after a reconnect.
 */
import {
  REALTIME_CLOSE_REAUTH,
  REALTIME_PING,
  REALTIME_PONG,
  type RealtimeChange,
  type PresenceListPrefix,
  type RealtimeClientMessage,
  type RealtimePerson,
  type RealtimePresence,
  type RealtimeServerMessage,
} from "@scalius/shared/realtime";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";

export type RealtimeStatus = "connecting" | "open" | "closed";

export interface RealtimeListener {
  changes?(items: RealtimeChange[]): void;
  presence?(key: string, people: RealtimePresence[]): void;
  saved?(key: string, by: RealtimePerson, rev: number | null, fields: string[]): void;
  /** The socket opened (first or after a gap): refetch what may have changed before. */
  resync?(): void;
  status?(status: RealtimeStatus): void;
}

const PING_MS = 45_000;
const PONG_TIMEOUT_MS = 10_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** After this many refusals in a row (signed out, no access), wait the longest step. */
const REFUSALS_BEFORE_LONG_WAIT = 3;
/** Focus reports per key at most every 200 ms: 5 a second, under the hub's 8. */
const FOCUS_INTERVAL_MS = 200;
const IDLE_FOCUS = JSON.stringify({ field: null, editing: false });

type SocketLike = Pick<WebSocket, "send" | "close" | "readyState" | "addEventListener">;

export interface RealtimeConnectionOptions {
  createSocket?: (url: string) => SocketLike;
  url?: () => string;
  now?: () => number;
  random?: () => number;
  /** Reconnect while this tab is hidden: it holds the socket for other tabs. */
  retryWhileHidden?: boolean;
}

function defaultUrl(): string {
  const url = new URL(withDashboardBasePath("/api/realtime"), window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class RealtimeConnection {
  private socket: SocketLike | null = null;
  private listeners = new Set<RealtimeListener>();
  private keys = new Map<string, number>();
  private lists = new Map<PresenceListPrefix, number>();
  /** The focus state each key should have at the hub, and what this socket last sent. */
  private focusWanted = new Map<string, string>();
  private focusSent = new Map<string, string>();
  private focusTimer: ReturnType<typeof setTimeout> | null = null;
  private status: RealtimeStatus = "closed";
  private attempts = 0;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly url: () => string;
  private readonly random: () => number;
  private readonly retryWhileHidden: boolean;

  constructor(options: RealtimeConnectionOptions = {}) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.url = options.url ?? defaultUrl;
    this.random = options.random ?? Math.random;
    this.retryWhileHidden = options.retryWhileHidden ?? false;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.wake);
      document.addEventListener("visibilitychange", this.onVisibility);
    }
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.wake);
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
    this.setStatus("closed");
  }

  subscribe(listener: RealtimeListener): () => void {
    this.listeners.add(listener);
    listener.status?.(this.status);
    return () => this.listeners.delete(listener);
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  /** An editor is open on `key` (counted, so two cards on one document share it). */
  watch(key: string): () => void {
    this.keys.set(key, (this.keys.get(key) ?? 0) + 1);
    this.sendKeys();
    return () => {
      const count = (this.keys.get(key) ?? 1) - 1;
      if (count <= 0) {
        this.keys.delete(key);
        this.focusWanted.delete(key);
        this.focusSent.delete(key);
      } else this.keys.set(key, count);
      this.sendKeys();
    };
  }

  /** A list that shows who has its records open is on screen (counted). */
  watchList(prefix: PresenceListPrefix): () => void {
    this.lists.set(prefix, (this.lists.get(prefix) ?? 0) + 1);
    this.sendKeys();
    return () => {
      const count = (this.lists.get(prefix) ?? 1) - 1;
      if (count <= 0) this.lists.delete(prefix);
      else this.lists.set(prefix, count);
      this.sendKeys();
    };
  }

  /** Tell the other editors on `key` that this one saved, and which fields it changed (keys, never values). */
  announceSave(key: string, rev: number | null, fields: readonly string[] = []): void {
    this.send({ t: "saved", key, rev, ...(fields.length > 0 ? { fields: [...fields] } : {}) });
  }

  /**
   * The field this tab is in on `key` (null for none) and whether it has
   * unsaved changes there. Coalesced: at most one message per key every
   * FOCUS_INTERVAL_MS, always ending on the latest state, under the hub's limit.
   */
  focus(key: string, field: string | null, editing: boolean): void {
    if (!this.keys.has(key)) return;
    this.focusWanted.set(key, JSON.stringify({ field, editing }));
    if (this.focusTimer) return;
    if (this.flushFocus()) this.focusTimer = setTimeout(this.focusTick, FOCUS_INTERVAL_MS);
  }

  /** Sends the latest state after a pause, and keeps pausing while there is more. */
  private readonly focusTick = () => {
    this.focusTimer = null;
    if (this.flushFocus()) this.focusTimer = setTimeout(this.focusTick, FOCUS_INTERVAL_MS);
  };

  /** Sends each key's focus state that the hub does not have yet; true when it sent any. */
  private flushFocus(): boolean {
    if (!this.socket || this.status !== "open") return false;
    let sent = false;
    for (const [key, wanted] of this.focusWanted) {
      if (this.focusSent.get(key) === wanted || (!this.focusSent.has(key) && wanted === IDLE_FOCUS)) continue;
      const { field, editing } = JSON.parse(wanted) as { field: string | null; editing: boolean };
      this.send({ t: "focus", key, field, editing });
      this.focusSent.set(key, wanted);
      sent = true;
    }
    return sent;
  }

  /** Check the socket now, or reconnect at once (another tab came back). */
  readonly wake = () => {
    if (this.stopped) return;
    if (this.socket && this.status !== "closed") {
      // A socket that survived a sleep may be dead without knowing: check it now.
      this.ping();
      return;
    }
    this.attempts = 0;
    this.open();
  };

  private readonly onVisibility = () => {
    if (document.visibilityState === "visible") this.wake();
  };

  private open(): void {
    if (this.stopped) return;
    this.clearTimers();
    // One socket at a time: a socket still opening is dropped, never doubled.
    const previous = this.socket;
    this.socket = null;
    try {
      previous?.close(1000);
    } catch {
      // Already gone.
    }
    this.setStatus("connecting");
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.url());
    } catch {
      this.scheduleRetry(false);
      return;
    }
    this.socket = socket;
    let opened = false;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      opened = true;
      this.attempts = 0;
      this.setStatus("open");
      this.sendKeys();
      // A new socket starts with no focus at the hub: send what is not idle again.
      this.focusSent.clear();
      if (this.flushFocus()) this.focusTimer = setTimeout(this.focusTick, FOCUS_INTERVAL_MS);
      this.pingTimer = setInterval(() => this.ping(), PING_MS);
      // The page read its data before this socket opened: catch up, the first time too.
      this.emit((listener) => listener.resync?.());
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.receive(String((event as MessageEvent).data));
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      this.setStatus("closed");
      const code = (event as CloseEvent).code;
      if (code === REALTIME_CLOSE_REAUTH) this.attempts = 0;
      this.scheduleRetry(!opened);
    });
  }

  private receive(data: string): void {
    if (data === REALTIME_PONG) {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
      return;
    }
    let message: RealtimeServerMessage;
    try {
      message = JSON.parse(data) as RealtimeServerMessage;
    } catch {
      return;
    }
    switch (message.t) {
      case "changes":
        if (Array.isArray(message.items)) this.emit((listener) => listener.changes?.(message.items));
        break;
      case "presence":
        this.emit((listener) => listener.presence?.(message.key, message.people ?? []));
        break;
      case "saved":
        this.emit((listener) => listener.saved?.(message.key, message.by, message.rev ?? null, Array.isArray(message.fields) ? message.fields : []));
        break;
      default:
        break;
    }
  }

  private ping(): void {
    if (!this.socket || this.status !== "open" || this.pongTimer) return;
    try {
      this.socket.send(REALTIME_PING);
    } catch {
      return;
    }
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      // No answer: the socket is dead. Drop it and reconnect now.
      const socket = this.socket;
      this.socket = null;
      this.clearTimers();
      try {
        socket?.close(4000);
      } catch {
        // Already gone.
      }
      this.setStatus("closed");
      this.attempts = 0;
      this.open();
    }, PONG_TIMEOUT_MS);
  }

  private scheduleRetry(refused: boolean): void {
    if (this.stopped) return;
    this.attempts += 1;
    const step = refused && this.attempts >= REFUSALS_BEFORE_LONG_WAIT
      ? MAX_BACKOFF_MS
      : Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (this.attempts - 1));
    const delay = step / 2 + this.random() * (step / 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // A hidden tab waits: it reconnects the moment it is shown.
      if (!this.retryWhileHidden && typeof document !== "undefined" && document.visibilityState === "hidden") return;
      this.open();
    }, delay);
  }

  private sendKeys(): void {
    const lists = [...this.lists.keys()];
    this.send({ t: "watch", keys: [...this.keys.keys()], ...(lists.length > 0 ? { lists } : {}) });
  }

  private send(message: RealtimeClientMessage): void {
    if (!this.socket || this.status !== "open") return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // The close handler reconnects.
    }
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit((listener) => listener.status?.(status));
  }

  private emit(call: (listener: RealtimeListener) => void): void {
    for (const listener of [...this.listeners]) {
      try {
        call(listener);
      } catch {
        // One broken listener must not stop the others.
      }
    }
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    if (this.focusTimer) clearTimeout(this.focusTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this.focusTimer = null;
  }
}

/** What screens and the bridge use of a connection, whichever tab holds the socket. */
export type RealtimeHandle = Pick<RealtimeConnection, "start" | "stop" | "subscribe" | "getStatus" | "watch" | "watchList" | "announceSave" | "focus">;

type FocusState = { field: string | null; editing: boolean };

/** What tabs say to each other on the browser's channel (never values, only keys and fields). */
type TabMessage =
  // A tab asks who holds the socket; the holder answers it (`to`), or tells every tab it took over.
  | { t: "hello"; tab: string }
  | { t: "leader"; tab: string; status: RealtimeStatus; to?: string }
  // A tab's whole registration: sent on start, to a new holder, and every heartbeat.
  | { t: "state"; tab: string; keys: string[]; lists: PresenceListPrefix[]; focus: Record<string, FocusState> }
  | { t: "focus"; tab: string; key: string; field: string | null; editing: boolean }
  | { t: "announce"; tab: string; key: string; rev: number | null; fields: string[] }
  | { t: "bye"; tab: string }
  | { t: "wake"; tab: string }
  // From the holder: what its socket heard.
  | { t: "status"; status: RealtimeStatus }
  | { t: "changes"; items: RealtimeChange[] }
  | { t: "presence"; key: string; people: RealtimePresence[] }
  | { t: "saved"; key: string; by: RealtimePerson; rev: number | null; fields: string[]; origin?: string }
  | { t: "resync" };

/** The browser channel a tab group talks on (`BroadcastChannel`, or a test's). */
export interface TabChannel {
  postMessage(message: TabMessage): void;
  addEventListener(type: "message", listener: (event: { data: TabMessage }) => void): void;
  close(): void;
}

/** Runs `hold` while this tab holds the group's exclusive lock (`navigator.locks.request`); it waits its turn. */
export type TabLock = (hold: () => Promise<void>) => void;

/** A follower re-sends its registration this often; a holder forgets a tab silent for three. */
const TAB_HEARTBEAT_MS = 20_000;

export interface SharedRealtimeOptions {
  /** The staff member: a save relayed between this browser's tabs is theirs. */
  selfId: string;
  channel: TabChannel;
  lock: TabLock;
  /** The socket the holder opens. */
  create: () => RealtimeConnection;
  tab?: string;
  now?: () => number;
}

/**
 * One socket for every tab of a browser (same staff member and permissions):
 * the tab holding the Web Lock opens it and relays what it hears; the other
 * tabs send it their editors, lists, focus and saves. When the holder closes,
 * the browser hands the lock to the next tab, which opens its own socket and
 * gathers the others' registrations again. Every tab reports `resync` whenever
 * the socket opens, and a tab that joins an open socket once.
 */
export class SharedRealtimeConnection implements RealtimeHandle {
  private readonly tab: string;
  private readonly now: () => number;
  private listeners = new Set<RealtimeListener>();
  private keys = new Map<string, number>();
  private lists = new Map<PresenceListPrefix, number>();
  private focusState = new Map<string, FocusState>();
  private status: RealtimeStatus = "connecting";
  private stopped = true;
  /** Holder only: the socket, the other tabs' registrations and what the hub last said per key. */
  private inner: RealtimeConnection | null = null;
  private innerUnsubscribe: (() => void) | null = null;
  private others = new Map<string, { keys: string[]; lists: PresenceListPrefix[]; focus: Record<string, FocusState>; seen: number }>();
  private innerKeys = new Map<string, () => void>();
  private innerLists = new Map<PresenceListPrefix, () => void>();
  private presence = new Map<string, RealtimePresence[]>();
  private releaseLock: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: SharedRealtimeOptions) {
    this.tab = options.tab ?? Math.random().toString(36).slice(2);
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.options.channel.addEventListener("message", this.onMessage);
    this.post({ t: "hello", tab: this.tab });
    this.postState();
    this.heartbeat = setInterval(this.beat, TAB_HEARTBEAT_MS);
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", this.leave);
      document.addEventListener("visibilitychange", this.onVisibility);
    }
    this.options.lock(() => new Promise<void>((release) => {
      if (this.stopped) {
        release();
        return;
      }
      this.releaseLock = release;
      this.lead();
    }));
  }

  stop(): void {
    if (this.stopped) return;
    this.leave();
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.leave);
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    this.stepDown();
    this.options.channel.close();
    this.setStatus("closed");
  }

  subscribe(listener: RealtimeListener): () => void {
    this.listeners.add(listener);
    listener.status?.(this.status);
    return () => this.listeners.delete(listener);
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  watch(key: string): () => void {
    this.keys.set(key, (this.keys.get(key) ?? 0) + 1);
    this.changed([key]);
    return () => {
      const count = (this.keys.get(key) ?? 1) - 1;
      if (count <= 0) {
        this.keys.delete(key);
        this.focusState.delete(key);
      } else this.keys.set(key, count);
      this.changed([]);
    };
  }

  watchList(prefix: PresenceListPrefix): () => void {
    this.lists.set(prefix, (this.lists.get(prefix) ?? 0) + 1);
    this.changed([], [prefix]);
    return () => {
      const count = (this.lists.get(prefix) ?? 1) - 1;
      if (count <= 0) this.lists.delete(prefix);
      else this.lists.set(prefix, count);
      this.changed([]);
    };
  }

  announceSave(key: string, rev: number | null, fields: readonly string[] = []): void {
    if (this.inner) this.relaySave(this.tab, key, rev, [...fields]);
    else this.post({ t: "announce", tab: this.tab, key, rev, fields: [...fields] });
  }

  focus(key: string, field: string | null, editing: boolean): void {
    if (!this.keys.has(key)) return;
    this.focusState.set(key, { field, editing });
    if (this.inner) this.inner.focus(key, field, editing);
    else this.post({ t: "focus", tab: this.tab, key, field, editing });
  }

  /** This tab's registration moved: tell the holder, or (holding) update the socket. */
  private changed(addedKeys: string[], addedLists: PresenceListPrefix[] = []): void {
    if (!this.inner) {
      this.postState();
      return;
    }
    this.syncInner();
    // A key or list another tab already had: the hub sends nothing new, so tell this tab what it said.
    for (const key of addedKeys) this.replayPresence(key, (call) => this.emit(call));
    for (const prefix of addedLists) this.replayList(prefix, (call) => this.emit(call));
  }

  private readonly beat = () => {
    if (this.inner) {
      // Forget tabs that went away without a word (a crash); their editors leave the hub.
      const silent = [...this.others].filter(([, other]) => this.now() - other.seen > TAB_HEARTBEAT_MS * 3).map(([tab]) => tab);
      for (const tab of silent) this.others.delete(tab);
      if (silent.length > 0) this.syncInner();
    } else this.postState();
  };

  private readonly leave = () => {
    if (!this.inner) this.post({ t: "bye", tab: this.tab });
  };

  private readonly onVisibility = () => {
    // A hidden holder does not see this tab come back: ask it to check its socket.
    if (document.visibilityState === "visible" && !this.inner) this.post({ t: "wake", tab: this.tab });
  };

  private postState(): void {
    this.post({
      t: "state",
      tab: this.tab,
      keys: [...this.keys.keys()],
      lists: [...this.lists.keys()],
      focus: Object.fromEntries(this.focusState),
    });
  }

  /** This tab holds the lock: open the socket for every tab. */
  private lead(): void {
    const inner = this.options.create();
    this.inner = inner;
    this.innerUnsubscribe = inner.subscribe({
      changes: (items) => {
        this.post({ t: "changes", items });
        this.emit((listener) => listener.changes?.(items));
      },
      presence: (key, people) => {
        this.presence.set(key, people);
        this.post({ t: "presence", key, people });
        this.emit((listener) => listener.presence?.(key, people));
      },
      saved: (key, by, rev, fields) => {
        this.post({ t: "saved", key, by, rev, fields });
        this.emit((listener) => listener.saved?.(key, by, rev, fields));
      },
      resync: () => {
        this.post({ t: "resync" });
        this.emit((listener) => listener.resync?.());
      },
      status: (status) => {
        if (status !== "open") this.presence.clear();
        this.post({ t: "status", status });
        this.setStatus(status);
      },
    });
    this.syncInner();
    for (const [key, state] of this.focusState) inner.focus(key, state.field, state.editing);
    inner.start();
    // The other tabs send their registrations to the new holder.
    this.post({ t: "leader", tab: this.tab, status: inner.getStatus() });
  }

  private stepDown(): void {
    this.innerUnsubscribe?.();
    this.innerUnsubscribe = null;
    this.inner?.stop();
    this.inner = null;
    this.innerKeys.clear();
    this.innerLists.clear();
    this.others.clear();
    this.presence.clear();
    this.releaseLock?.();
    this.releaseLock = null;
  }

  /** The socket watches every key and list any tab has open. */
  private syncInner(): void {
    const inner = this.inner;
    if (!inner) return;
    const keys = new Set(this.keys.keys());
    const lists = new Set(this.lists.keys());
    for (const other of this.others.values()) {
      for (const key of other.keys) keys.add(key);
      for (const prefix of other.lists) lists.add(prefix);
    }
    for (const [key, release] of this.innerKeys) if (!keys.has(key)) { release(); this.innerKeys.delete(key); }
    for (const key of keys) if (!this.innerKeys.has(key)) this.innerKeys.set(key, inner.watch(key));
    for (const [prefix, release] of this.innerLists) if (!lists.has(prefix)) { release(); this.innerLists.delete(prefix); }
    for (const prefix of lists) if (!this.innerLists.has(prefix)) this.innerLists.set(prefix, inner.watchList(prefix));
  }

  private replayPresence(key: string, send: (call: (listener: RealtimeListener) => void) => void): void {
    const people = this.presence.get(key);
    if (people) send((listener) => listener.presence?.(key, people));
  }

  private replayList(prefix: PresenceListPrefix, send: (call: (listener: RealtimeListener) => void) => void): void {
    for (const key of this.presence.keys()) if (key.startsWith(`${prefix}:`)) this.replayPresence(key, send);
  }

  /** A save in this browser: the hub tells the other people; the holder tells this browser's other tabs. */
  private relaySave(origin: string, key: string, rev: number | null, fields: string[]): void {
    this.inner?.announceSave(key, rev, fields);
    const by: RealtimePerson = { id: this.options.selfId, name: "" };
    this.post({ t: "saved", key, by, rev, fields, origin });
    if (origin !== this.tab && this.keys.has(key)) this.emit((listener) => listener.saved?.(key, by, rev, fields));
  }

  private readonly onMessage = (event: { data: TabMessage }) => {
    if (this.stopped) return;
    const message = event.data;
    if (this.inner) {
      this.holderHears(message);
      return;
    }
    switch (message.t) {
      case "leader":
        this.postState();
        this.setStatus(message.status);
        // This tab joined an open socket: what it loaded meanwhile may be stale. (A socket
        // that opens later says `resync` itself.)
        if (message.to === this.tab && message.status === "open") this.emit((listener) => listener.resync?.());
        break;
      case "status":
        this.setStatus(message.status);
        break;
      case "changes":
        this.emit((listener) => listener.changes?.(message.items));
        break;
      case "presence":
        if (this.keys.has(message.key) || [...this.lists.keys()].some((prefix) => message.key.startsWith(`${prefix}:`))) {
          this.emit((listener) => listener.presence?.(message.key, message.people));
        }
        break;
      case "saved":
        if (message.origin !== this.tab && this.keys.has(message.key)) {
          this.emit((listener) => listener.saved?.(message.key, message.by, message.rev, message.fields));
        }
        break;
      case "resync":
        this.emit((listener) => listener.resync?.());
        break;
      default:
        break;
    }
  };

  /** The holder hears another tab. */
  private holderHears(message: TabMessage): void {
    const inner = this.inner!;
    switch (message.t) {
      case "hello":
        this.post({ t: "leader", tab: this.tab, status: inner.getStatus(), to: message.tab });
        break;
      case "state": {
        const before = this.others.get(message.tab);
        this.others.set(message.tab, { keys: message.keys, lists: message.lists, focus: message.focus, seen: this.now() });
        this.syncInner();
        for (const [key, state] of Object.entries(message.focus)) inner.focus(key, state.field, state.editing);
        // What the hub already said about the keys and lists that tab just opened.
        const send = (call: (listener: RealtimeListener) => void) => call({
          presence: (key, people) => this.post({ t: "presence", key, people }),
        });
        for (const key of message.keys) if (!before?.keys.includes(key)) this.replayPresence(key, send);
        for (const prefix of message.lists) if (!before?.lists.includes(prefix)) this.replayList(prefix, send);
        break;
      }
      case "focus":
        inner.focus(message.key, message.field, message.editing);
        break;
      case "announce":
        this.relaySave(message.tab, message.key, message.rev, message.fields);
        break;
      case "bye":
        if (this.others.delete(message.tab)) this.syncInner();
        break;
      case "wake":
        inner.wake();
        break;
      default:
        break;
    }
  }

  private post(message: TabMessage): void {
    try {
      this.options.channel.postMessage(message);
    } catch {
      // A closed channel: this tab is stopping.
    }
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit((listener) => listener.status?.(status));
  }

  private emit(call: (listener: RealtimeListener) => void): void {
    for (const listener of [...this.listeners]) {
      try {
        call(listener);
      } catch {
        // One broken listener must not stop the others.
      }
    }
  }
}

/**
 * The browser's shared connection when it has Web Locks and BroadcastChannel,
 * else this tab's own socket. `key` names the staff member and permissions:
 * tabs of another person (or other permissions) never share a socket.
 */
export function createTabRealtime(key: string, selfId: string): RealtimeHandle {
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (typeof BroadcastChannel === "undefined" || !locks?.request) return new RealtimeConnection();
  const name = `scalius-realtime:${key}`;
  return new SharedRealtimeConnection({
    selfId,
    channel: new BroadcastChannel(name) as unknown as TabChannel,
    lock: (hold) => void locks.request(name, hold).catch(() => undefined),
    // The holder keeps the socket for every tab, even while its own tab is hidden.
    create: () => new RealtimeConnection({ retryWhileHidden: true }),
  });
}

/**
 * The tab's one connection. Holders share it; the last release stops it on
 * the next task, so a remount (React's StrictMode replay, the frame switching
 * layout) takes the same socket over instead of opening a second one. A new
 * `key` (another user, other permissions) replaces it: the hub proves who the
 * socket is at the upgrade only.
 */
let shared: { key: string; connection: RealtimeHandle; holders: number } | null = null;

export function acquireRealtimeConnection(
  key: string,
  create: () => RealtimeHandle = () => new RealtimeConnection(),
): { connection: RealtimeHandle; release(): void } {
  if (shared && shared.key !== key) {
    shared.connection.stop();
    shared = null;
  }
  if (!shared) {
    shared = { key, connection: create(), holders: 0 };
    shared.connection.start();
  }
  const entry = shared;
  entry.holders += 1;
  let released = false;
  return {
    connection: entry.connection,
    release() {
      if (released) return;
      released = true;
      entry.holders -= 1;
      if (entry.holders > 0) return;
      setTimeout(() => {
        if (entry.holders > 0) return;
        entry.connection.stop();
        if (shared === entry) shared = null;
      }, 0);
    },
  };
}
