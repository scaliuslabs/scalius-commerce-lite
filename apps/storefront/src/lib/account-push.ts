/**
 * Account → Profile → Browser notifications (Web Push): the state logic and
 * the control that drives it. The control exists only when JavaScript runs,
 * the browser has `PushManager`, and the store can send (`available`).
 * "Turn on" asks the browser for permission, registers `/push-sw.js`,
 * subscribes with the store's public key and tells the API; "Turn off" does
 * the reverse. The browser's push endpoint is a bearer address for this
 * buyer: it travels in POST bodies to the same-origin account proxy only,
 * never in a URL, a log line or an analytics payload.
 */
import type { AccountPushCopy } from "./account-push-copy";

export const PUSH_SERVICE_WORKER_PATH = "/push-sw.js";

export type PushViewState = "hidden" | "off" | "on" | "blocked";

interface PushStateAnswer {
  publicKey: string | null;
  available: boolean;
  subscribed: boolean;
}

/** The browser and API surface the control uses; tests replace it. */
export interface PushDeps {
  supported(): boolean;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  /** The registration this control made earlier, if any. */
  getRegistration(): Promise<ServiceWorkerRegistration | undefined>;
  /** Registers the service worker and waits until it is active. */
  register(): Promise<ServiceWorkerRegistration>;
  /** A JSON POST to the account API; the parsed `data` of a successful envelope, else null. */
  post(path: string, body: Record<string, unknown>): Promise<unknown | null>;
  deviceLabel(): string;
}

/** A VAPID public key (base64url) as the bytes `subscribe()` takes. */
export function decodePublicKey(key: string): Uint8Array<ArrayBuffer> {
  const padded = key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** "Chrome on Android": a coarse name so the buyer can tell their browsers apart; never an exact user agent. */
export function deviceLabelOf(userAgent: string): string {
  const browser = /Edg\//.test(userAgent) ? "Edge"
    : /OPR\/|Opera/.test(userAgent) ? "Opera"
      : /Firefox\/|FxiOS/.test(userAgent) ? "Firefox"
        : /Chrome\/|CriOS/.test(userAgent) ? "Chrome"
          : /Safari\//.test(userAgent) ? "Safari"
            : "Browser";
  const system = /iPhone/.test(userAgent) ? "iPhone"
    : /iPad/.test(userAgent) ? "iPad"
      : /Android/.test(userAgent) ? "Android"
        : /Windows/.test(userAgent) ? "Windows"
          : /Mac OS X|Macintosh/.test(userAgent) ? "Mac"
            : /Linux|CrOS/.test(userAgent) ? "Linux"
              : "";
  return system ? `${browser} on ${system}` : browser;
}

function readState(data: unknown): PushStateAnswer | null {
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  if (typeof value.available !== "boolean" || typeof value.subscribed !== "boolean") return null;
  return {
    publicKey: typeof value.publicKey === "string" && value.publicKey ? value.publicKey : null,
    available: value.available,
    subscribed: value.subscribed,
  };
}

export interface PushRead {
  view: PushViewState;
  /** The store's public key, when the control can turn notifications on. */
  publicKey: string | null;
}

/** What the control shows now. Anything unreadable hides it: the buyer loses nothing. */
export async function readPushState(deps: PushDeps): Promise<PushRead> {
  const hidden: PushRead = { view: "hidden", publicKey: null };
  try {
    if (!deps.supported()) return hidden;
    const registration = await deps.getRegistration();
    const existing = await registration?.pushManager.getSubscription();
    const answer = readState(await deps.post("/push/state", existing ? { endpoint: existing.endpoint } : {}));
    if (!answer || !answer.available || !answer.publicKey) return hidden;
    if (deps.permission() === "denied") return { view: "blocked", publicKey: answer.publicKey };
    return { view: existing && answer.subscribed ? "on" : "off", publicKey: answer.publicKey };
  } catch {
    return hidden;
  }
}

export type PushChange = { ok: true; view: PushViewState } | { ok: false; view: PushViewState };

/**
 * Turns notifications on for this browser. Call it straight from the click:
 * the browser only shows its permission prompt for a user gesture.
 */
export async function turnPushOn(deps: PushDeps, publicKey: string): Promise<PushChange> {
  try {
    const permission = await deps.requestPermission();
    if (permission === "denied") return { ok: true, view: "blocked" };
    if (permission !== "granted") return { ok: true, view: "off" };
    const registration = await deps.register();
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodePublicKey(publicKey),
    });
    const json = subscription.toJSON();
    const saved = await deps.post("/push/subscribe", {
      endpoint: json.endpoint ?? subscription.endpoint,
      keys: json.keys,
      deviceLabel: deps.deviceLabel(),
    });
    if (!saved) {
      // The account does not know this browser: do not keep a subscription nobody can send to.
      await subscription.unsubscribe().catch(() => false);
      return { ok: false, view: "off" };
    }
    return { ok: true, view: "on" };
  } catch {
    return { ok: false, view: "off" };
  }
}

/** Turns notifications off for this browser: the account first, then the browser. */
export async function turnPushOff(deps: PushDeps): Promise<PushChange> {
  try {
    const registration = await deps.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      const removed = await deps.post("/push/unsubscribe", { endpoint: subscription.endpoint });
      if (!removed) return { ok: false, view: "on" };
      await subscription.unsubscribe().catch(() => false);
    }
    return { ok: true, view: "off" };
  } catch {
    return { ok: false, view: "on" };
  }
}

/** The browser and account API for the real page. */
export function browserPushDeps(win: Window & typeof globalThis): PushDeps {
  const scope = "/";
  return {
    supported: () => "serviceWorker" in win.navigator && "PushManager" in win && "Notification" in win,
    permission: () => win.Notification.permission,
    requestPermission: () => win.Notification.requestPermission(),
    getRegistration: async () => {
      const registration = await win.navigator.serviceWorker.getRegistration(scope);
      // Only the worker this control registered; an app's own worker is not ours to subscribe through.
      return registration && [registration.active, registration.waiting, registration.installing].some((worker) => worker && new URL(worker.scriptURL).pathname === PUSH_SERVICE_WORKER_PATH)
        ? registration
        : undefined;
    },
    register: async () => {
      // The store's icon rides along as a query so the worker can show it; it is not buyer data.
      const icon = win.document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href;
      const url = icon ? `${PUSH_SERVICE_WORKER_PATH}?${new URLSearchParams({ icon })}` : PUSH_SERVICE_WORKER_PATH;
      await win.navigator.serviceWorker.register(url, { scope });
      return win.navigator.serviceWorker.ready;
    },
    post: async (path, body) => {
      const response = await win.fetch(`/api/customer-auth${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify(body),
      });
      if (!response.ok) return null;
      const json = (await response.json().catch(() => null)) as { success?: boolean; data?: unknown } | null;
      return json?.success === true ? json.data ?? null : null;
    },
    deviceLabel: () => deviceLabelOf(win.navigator.userAgent),
  };
}

const STATE_KEY = { on: "on", off: "off", blocked: "blocked" } as const;

/**
 * Wires the server-rendered section (`[data-account-push]`, hidden): it shows
 * only when the state reads as on, off or blocked.
 */
export async function initPushControl(
  section: HTMLElement,
  copy: AccountPushCopy,
  deps: PushDeps,
  signal?: AbortSignal,
): Promise<void> {
  const status = section.querySelector<HTMLElement>("[data-push-status]");
  const hint = section.querySelector<HTMLElement>("[data-push-hint]");
  const toggle = section.querySelector<HTMLButtonElement>("[data-push-toggle]");
  if (!status || !hint || !toggle) return;

  let view: PushViewState = "hidden";
  let publicKey: string | null = null;
  let busy = false;

  const render = (error = false) => {
    section.hidden = view === "hidden";
    if (view === "hidden") return;
    status.textContent = copy[STATE_KEY[view]];
    status.dataset.state = view;
    hint.textContent = error ? copy.failed : view === "blocked" ? copy.blockedHint : "";
    hint.hidden = !hint.textContent;
    toggle.hidden = view === "blocked";
    toggle.disabled = busy;
    toggle.textContent = busy ? copy.working : view === "on" ? copy.turnOff : copy.turnOn;
    toggle.setAttribute("aria-pressed", String(view === "on"));
    toggle.setAttribute("aria-busy", String(busy));
  };

  const read = await readPushState(deps);
  if (signal?.aborted) return;
  view = read.view;
  publicKey = read.publicKey;
  render();

  toggle.addEventListener("click", () => {
    if (busy || view === "hidden" || view === "blocked") return;
    busy = true;
    render();
    // No await before the change starts: the permission prompt needs the click.
    const change = view === "on" ? turnPushOff(deps) : publicKey ? turnPushOn(deps, publicKey) : Promise.resolve<PushChange>({ ok: false, view });
    void change.then((result) => {
      busy = false;
      view = result.view;
      render(!result.ok);
      toggle.focus();
    });
  }, { signal });
}
