/**
 * Staff Web Push from this dashboard browser (`/api/v1/admin/web-push`): the
 * dashboard's one staff push path. The worker `public/web-push-sw.js` shows
 * each push (and tells open dashboard tabs, for the bell); this module
 * subscribes and unsubscribes the browser, tells the API, sends test
 * notifications and says exactly why a browser cannot receive them.
 * Not in the generated SDK yet; the response shapes are typed here.
 */
import { apiClient, apiData } from "./api";
import { withDashboardBasePath } from "./dashboard-base-path";

export const WEB_PUSH_URL = "/api/v1/admin/web-push";
const JSON_HEADERS = { "Content-Type": "application/json" };
const DEVICE_STORAGE_KEY = "scalius-web-push-device";

export interface WebPushDevice {
  id: string;
  deviceLabel: string | null;
  lastSuccessAt: string | null;
  createdAt: string;
  /** Sends that failed in a row since the push service last accepted one. */
  failureCount: number;
}

/** What the push service answered a test: `gone` means the browser dropped it (the API removed it). */
export type TestPushOutcome = "sent" | "failed" | "gone";

export interface WebPushState {
  publicKey: string | null;
  /** Whether the Worker can send: it needs an https dashboard address. */
  available: boolean;
  devices: WebPushDevice[];
}

export const webPushQuery = {
  queryKey: ["admin", "web-push"] as const,
  queryFn: () => apiData(apiClient.get<{ 200: { success: boolean; data: WebPushState } }>({ url: WEB_PUSH_URL })),
};

/** Whether this browser can receive Web Push at all (service workers, PushManager, notifications). */
export function webPushSupported(): boolean {
  return typeof window !== "undefined"
    && typeof navigator !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

/** An iPhone or iPad (iPadOS reports a Mac with touch). */
export function isAppleMobile(userAgent: string, maxTouchPoints = 0): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** Opened from the Home Screen (an installed web app), where iOS allows Web Push. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches === true
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * Why this browser cannot receive staff notifications, or null when it can
 * (the server's side, an https store address, is `available` from the API):
 * - `https`: the store has no https web address (or the dashboard is not on one);
 * - `homeScreen`: iPhone and iPad allow Web Push only from the Home Screen (Apple's rule);
 * - `iosVersion`: on the Home Screen, but iOS is older than 16.4;
 * - `unsupported`: this browser has no Web Push;
 * - `blocked`: notifications are blocked for the dashboard in this browser.
 */
export type PushBlocker = "https" | "homeScreen" | "iosVersion" | "unsupported" | "blocked";

export function pushBlocker(available: boolean | undefined): PushBlocker | null {
  if (typeof window === "undefined") return "unsupported";
  if (available === false || !window.isSecureContext) return "https";
  if (isAppleMobile(navigator.userAgent, navigator.maxTouchPoints) && !webPushSupported()) {
    return isStandalone() ? "iosVersion" : "homeScreen";
  }
  if (!webPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return null;
}

/** Sends a test notification to one of this staff member's browsers, in the dashboard's language. */
export async function sendTestPush(deviceId: string, text: { title: string; body: string }): Promise<TestPushOutcome> {
  const result = await apiData(apiClient.post<{ 200: { success: boolean; data: { outcome: TestPushOutcome } } }>({
    url: `${WEB_PUSH_URL}/devices/${encodeURIComponent(deviceId)}/test`,
    headers: JSON_HEADERS,
    body: text,
  }));
  return result.outcome;
}

/** "Chrome on macOS": the browser and system from the user agent, nothing finer. */
export function browserAndSystem(userAgent: string): { browser: string; system: string } {
  const browser = /Edg\//.test(userAgent) ? "Edge"
    : /OPR\/|Opera/.test(userAgent) ? "Opera"
      : /Firefox\//.test(userAgent) ? "Firefox"
        : /Chrome\/|CriOS\//.test(userAgent) ? "Chrome"
          : /Safari\//.test(userAgent) ? "Safari"
            : "";
  const system = /Android/.test(userAgent) ? "Android"
    : /iPhone|iPad|iPod/.test(userAgent) ? "iOS"
      : /Windows/.test(userAgent) ? "Windows"
        : /Mac OS X|Macintosh/.test(userAgent) ? "macOS"
          : /CrOS/.test(userAgent) ? "ChromeOS"
            : /Linux/.test(userAgent) ? "Linux"
              : "";
  return { browser, system };
}

/** The Web Push public key (URL-safe base64) as the bytes `subscribe` wants. */
export function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const padded = publicKey.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(publicKey.length / 4) * 4, "=");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options?.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((byte, index) => byte === key[index]);
}

function workerUrl(): string {
  return withDashboardBasePath("/web-push-sw.js");
}

function workerScope(): string {
  return withDashboardBasePath("/web-push/");
}

/** This browser's registration, once its worker is active (`subscribe` needs an active worker). */
async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register(workerUrl(), { scope: workerScope() });
  if (registration.active) return registration;
  const worker = registration.installing ?? registration.waiting;
  if (!worker) return registration;
  await new Promise<void>((resolve, reject) => {
    const settle = () => {
      if (worker.state === "activated") resolve();
      else if (worker.state === "redundant") reject(new Error("The notification worker did not start."));
    };
    worker.addEventListener("statechange", settle);
    settle();
  });
  return registration;
}

/** This browser's push subscription for the dashboard, or null (never registers a worker). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!webPushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration(workerScope());
  return (await registration?.pushManager.getSubscription()) ?? null;
}

function rememberDevice(id: string | null): void {
  try {
    if (id) localStorage.setItem(DEVICE_STORAGE_KEY, id);
    else localStorage.removeItem(DEVICE_STORAGE_KEY);
  } catch {
    // Storage can be blocked; the device then just is not marked "This device".
  }
}

/** The id the API gave this browser when it subscribed, if this browser remembers it. */
export function thisDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Asks for permission, subscribes this browser and saves it with the API.
 * Returns "blocked" when the merchant refuses permission (nothing is saved).
 */
export async function turnOnThisDevice(publicKey: string, deviceLabel: string): Promise<{ id: string } | "blocked"> {
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") return "blocked";
  const registration = await activeRegistration();
  const key = applicationServerKey(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  // A subscription made with another key (the key was replaced) cannot receive this store's pushes.
  if (subscription && !sameKey(subscription, key)) {
    await subscription.unsubscribe();
    await apiData(apiClient.post({
      url: `${WEB_PUSH_URL}/subscriptions/remove`,
      headers: JSON_HEADERS,
      body: { endpoint: subscription.endpoint },
    })).catch(() => undefined);
    rememberDevice(null);
    subscription = null;
  }
  const created = !subscription;
  try {
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const saved = await apiData(apiClient.post<{ 200: { success: boolean; data: { id: string } } }>({
      url: `${WEB_PUSH_URL}/subscriptions`,
      headers: JSON_HEADERS,
      body: { ...subscription.toJSON(), deviceLabel },
    }));
    rememberDevice(saved.id);
    return { id: saved.id };
  } catch (error) {
    rememberDevice(null);
    if (created) await subscription?.unsubscribe().catch(() => false);
    throw error;
  }
}

/**
 * Whether this browser is on now, from the browser alone (no request): a
 * subscription, granted permission, and the device id the API gave it.
 * The bell reads this on every page; Settings checks the server's list too.
 */
export async function thisBrowserIsOn(publicKey?: string | null): Promise<boolean> {
  if (!webPushSupported() || Notification.permission !== "granted") return false;
  try {
    const subscription = await currentSubscription();
    return Boolean(subscription && (!publicKey || sameKey(subscription, applicationServerKey(publicKey)))) && thisDeviceId() !== null;
  } catch {
    return false;
  }
}

/** Unsubscribes this browser and tells the API to forget it. */
export async function turnOffThisDevice(): Promise<void> {
  const subscription = await currentSubscription();
  if (subscription) {
    await apiData(apiClient.post({
      url: `${WEB_PUSH_URL}/subscriptions/remove`,
      headers: JSON_HEADERS,
      body: { endpoint: subscription.endpoint },
    }));
    await subscription.unsubscribe();
  }
  rememberDevice(null);
}

/** Removes one of the staff member's other browsers by the id the API listed. */
export async function removeDevice(id: string): Promise<void> {
  await apiData(apiClient.delete({ url: `${WEB_PUSH_URL}/devices/${encodeURIComponent(id)}` }));
  if (thisDeviceId() === id) rememberDevice(null);
}
