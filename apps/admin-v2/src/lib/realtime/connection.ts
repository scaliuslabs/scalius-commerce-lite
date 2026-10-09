/**
 * The dashboard's one WebSocket to the store's realtime hub
 * (docs/platform/REALTIME.md). Small on purpose: it loads lazily with the
 * admin frame (components/admin/realtime/RealtimeBridge.tsx).
 *
 * - Reconnects with backoff and jitter (1 s doubling to 30 s), at once when
 *   the browser comes back online or the tab becomes visible.
 * - After any gap (offline, sleep, a hub restart) it reports `resync`, so the
 *   bridge refetches what may have been missed.
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
  /** The socket (re)opened after a gap: refetch what may have changed meanwhile. */
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
  private everOpened = false;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly url: () => string;
  private readonly random: () => number;

  constructor(options: RealtimeConnectionOptions = {}) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.url = options.url ?? defaultUrl;
    this.random = options.random ?? Math.random;
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

  private readonly wake = () => {
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
      if (this.everOpened) this.emit((listener) => listener.resync?.());
      this.everOpened = true;
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
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
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

/**
 * The tab's one connection. Holders share it; the last release stops it on
 * the next task, so a remount (React's StrictMode replay, the frame switching
 * layout) takes the same socket over instead of opening a second one. A new
 * `key` (another user, other permissions) replaces it: the hub proves who the
 * socket is at the upgrade only.
 */
let shared: { key: string; connection: RealtimeConnection; holders: number } | null = null;

export function acquireRealtimeConnection(
  key: string,
  create: () => RealtimeConnection = () => new RealtimeConnection(),
): { connection: RealtimeConnection; release(): void } {
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
