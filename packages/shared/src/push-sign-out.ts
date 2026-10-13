/** Best-effort device cleanup before auth logout. Queued payload display needs its own owner guard. */
const RELEASE_DEADLINE_MS = 2_500;

/** Enrollment can retry after a stalled activation; never remove a worker that may still start. */
export function waitForActivePushWorker(registration: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration> {
  if (registration.active) return Promise.resolve(registration);
  const worker = registration.installing ?? registration.waiting;
  if (!worker) return Promise.reject(new Error("The notification worker did not start."));
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      worker.removeEventListener("statechange", settle);
      if (error) reject(error); else resolve(registration);
    };
    const settle = () => {
      if (worker.state === "activated") finish();
      else if (worker.state === "redundant") finish(new Error("The notification worker did not start."));
    };
    const timer = setTimeout(() => finish(new Error("The notification worker took too long to start.")), 15_000);
    worker.addEventListener("statechange", settle);
    settle();
  });
}

export interface PushSignOutCleanup {
  /** Returns only this app's existing worker. Never register one during sign-out. */
  getRegistration(): Promise<ServiceWorkerRegistration | undefined>;
  /** Existing owner-scoped endpoint removal; endpoint stays in the POST body. */
  removeSubscription(endpoint: string, signal: AbortSignal): Promise<unknown>;
  /** Compare with the captured device id before clearing a browser marker. */
  forgetDevice?(): void;
}

/** A bounded handshake; old workers cannot acknowledge the guarded protocol. */
export function messagePushWorker(
  registration: ServiceWorkerRegistration,
  type: "scalius:push:sign-out" | "scalius:push:enrolled",
  startedAt?: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const worker = registration.active;
    if (!worker || typeof MessageChannel === "undefined") { resolve(false); return; }
    let channel: MessageChannel;
    try { channel = new MessageChannel(); }
    catch { resolve(false); return; }
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 500);
    channel.port1.onmessage = (event: MessageEvent) => finish(event.data?.ok === true);
    try { worker.postMessage({ type, startedAt }, [channel.port2]); }
    catch { finish(false); }
  });
}

/** Cleanup errors cannot prevent sign-out; no continuation starts mutations after the deadline. */
export async function releasePushBeforeSignOut(deps: PushSignOutCleanup): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(); }, RELEASE_DEADLINE_MS);
  });
  const cleanup = (async () => {
    const registration = await deps.getRegistration();
    if (!registration || controller.signal.aborted) return;
    // Fence the worker before subscription lookup: that lookup can hang or fail too.
    const guarded = messagePushWorker(registration, "scalius:push:sign-out");
    const closed = (async () => {
      const notifications = await registration.getNotifications();
      if (controller.signal.aborted) return;
      for (const notification of notifications) notification.close();
    })().catch(() => undefined);
    const snapshot = await registration.pushManager.getSubscription();
    if (controller.signal.aborted) return;

    // Independent attempts: a failed account request must not skip native cleanup.
    await Promise.allSettled([
      guarded,
      closed,
      (async () => {
        if (snapshot && !controller.signal.aborted) {
          await deps.removeSubscription(snapshot.endpoint, controller.signal);
        }
      })(),
      (async () => {
        if (!snapshot) return;
        const current = await registration.pushManager.getSubscription();
        if (controller.signal.aborted || current?.endpoint !== snapshot.endpoint) return;
        await current.unsubscribe();
      })(),
    ]);
  })().catch(() => undefined);
  try {
    await Promise.race([cleanup, expired]);
  } finally {
    controller.abort();
    clearTimeout(timer);
    try { deps.forgetDevice?.(); } catch { /* Browser storage may be blocked. */ }
  }
}
