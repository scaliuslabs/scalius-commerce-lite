// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { messagePushWorker, releasePushBeforeSignOut, waitForActivePushWorker } from "./push-sign-out";

function fixture() {
  const unsubscribe = vi.fn(async () => true);
  const subscription = { endpoint: "https://push.example/A", unsubscribe };
  const close = vi.fn();
  const registration = {
    active: null,
    update: vi.fn(async () => undefined),
    pushManager: { getSubscription: vi.fn(async () => subscription) },
    getNotifications: vi.fn(async () => [{ close }]),
  };
  const removeSubscription = vi.fn(async (_endpoint: string, _signal: AbortSignal) => undefined);
  const getRegistration = vi.fn(async () => registration as unknown as ServiceWorkerRegistration);
  const forgetDevice = vi.fn();
  return { registration, subscription, unsubscribe, close, removeSubscription, getRegistration, forgetDevice };
}

afterEach(() => vi.useRealTimers());

describe("bounded notification activation", () => {
  function activation(state = "installing") {
    const worker = Object.assign(new EventTarget(), { state });
    const remove = vi.spyOn(worker, "removeEventListener");
    const registration = { active: null, installing: worker, waiting: null } as unknown as ServiceWorkerRegistration;
    return { worker, remove, registration };
  }

  it("rejects a stalled worker, removes its listener, and permits a later retry", async () => {
    vi.useFakeTimers();
    const f = activation();
    const rejected = expect(waitForActivePushWorker(f.registration)).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(f.remove).toHaveBeenCalledExactlyOnceWith("statechange", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    f.worker.state = "activated";
    await expect(waitForActivePushWorker(f.registration)).resolves.toBe(f.registration);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["activated", "redundant"])("settles %s and removes its timer and listener", async (state) => {
    vi.useFakeTimers();
    const f = activation();
    const pending = waitForActivePushWorker(f.registration);
    const result = state === "activated" ? expect(pending).resolves.toBe(f.registration) : expect(pending).rejects.toThrow("did not start");
    f.worker.state = state;
    f.worker.dispatchEvent(new Event("statechange"));
    await result;
    expect(f.remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the existing active worker while an update installs and rejects a missing worker", async () => {
    const f = activation();
    const add = vi.spyOn(f.worker, "addEventListener");
    const active = { ...f.registration, active: {} } as ServiceWorkerRegistration;
    await expect(waitForActivePushWorker(active)).resolves.toBe(active);
    expect(add).not.toHaveBeenCalled();
    await expect(waitForActivePushWorker({ active: null, installing: null, waiting: null } as ServiceWorkerRegistration)).rejects.toThrow("did not start");
  });
});

describe("bounded device release before sign-out", () => {
  it("delivers the worker fence before subscription lookup and accepts its port acknowledgement", async () => {
    const f = fixture();
    const calls: string[] = [];
    const postMessage = vi.fn((_message: unknown, ports: MessagePort[]) => {
      calls.push("fence");
      ports[0]!.postMessage({ ok: true });
    });
    f.getRegistration.mockResolvedValue({ ...f.registration, active: { postMessage } } as unknown as ServiceWorkerRegistration);
    f.registration.pushManager.getSubscription.mockImplementation(async () => {
      calls.push("subscription");
      return f.subscription;
    });
    await releasePushBeforeSignOut(f);
    expect(calls[0]).toBe("fence");
    expect(postMessage.mock.calls[0]![0]).toEqual({ type: "scalius:push:sign-out", startedAt: undefined });
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("treats an old worker's missing acknowledgement as a bounded failure", async () => {
    vi.useFakeTimers();
    const registration = { active: { postMessage: vi.fn() } } as unknown as ServiceWorkerRegistration;
    const pending = messagePushWorker(registration, "scalius:push:enrolled", 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBe(false);
  });

  it("tries native cleanup and closes only this registration even when server removal rejects", async () => {
    const f = fixture();
    f.removeSubscription.mockRejectedValue(new Error("offline"));
    await releasePushBeforeSignOut(f);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.registration.update).not.toHaveBeenCalled();
    expect(f.forgetDevice).toHaveBeenCalledOnce();
  });

  it("tries server removal despite native failure", async () => {
    const f = fixture();
    f.unsubscribe.mockRejectedValue(new Error("native unavailable"));
    await releasePushBeforeSignOut(f);
    expect(f.removeSubscription).toHaveBeenCalledWith(f.subscription.endpoint, expect.any(AbortSignal));
  });

  it("does not unsubscribe a replacement endpoint from another tab", async () => {
    const f = fixture();
    const other = { endpoint: "https://push.example/B", unsubscribe: vi.fn(async () => true) };
    f.registration.pushManager.getSubscription.mockResolvedValueOnce(f.subscription).mockResolvedValueOnce(other);
    await releasePushBeforeSignOut(f);
    expect(f.unsubscribe).not.toHaveBeenCalled();
    expect(other.unsubscribe).not.toHaveBeenCalled();
  });

  it("proceeds to auth once at the deadline, aborting a hung server operation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.removeSubscription.mockImplementation(() => new Promise(() => undefined));
    f.unsubscribe.mockImplementation(() => new Promise(() => undefined));
    const auth = vi.fn();
    const pending = releasePushBeforeSignOut(f).then(auth);
    await vi.advanceTimersByTimeAsync(2_500);
    await pending;
    expect(auth).toHaveBeenCalledOnce();
    expect(f.removeSubscription.mock.calls[0]![1].aborted).toBe(true);
  });

  it("does not start late native/server mutations when a registration read resolves after logout", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: (registration: ServiceWorkerRegistration) => void;
    f.getRegistration.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = releasePushBeforeSignOut(f);
    await vi.advanceTimersByTimeAsync(2_500);
    await pending;
    resolve(f.registration as unknown as ServiceWorkerRegistration);
    await Promise.resolve();
    expect(f.removeSubscription).not.toHaveBeenCalled();
    expect(f.unsubscribe).not.toHaveBeenCalled();
  });
});
