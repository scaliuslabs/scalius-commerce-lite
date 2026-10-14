// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_CHECK_MS,
  PASS_LIMIT,
  RECHECK_MS,
  SESSION_LIMIT,
  UPLOAD_GRACE_MS,
  startPendingRenditions,
} from "./pending-renditions-runner";

const engine = vi.hoisted(() => ({ renderPendingRenditions: vi.fn() }));
vi.mock("./render-pending-renditions", () => engine);

let visibility: DocumentVisibilityState;
let lockHeldElsewhere: boolean;

async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("startPendingRenditions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    engine.renderPendingRenditions.mockReset().mockResolvedValue({ rendered: 0, failed: 0, more: false });
    visibility = "visible";
    lockHeldElsewhere = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.stubGlobal("navigator", {
      onLine: true,
      locks: { request: (_name: string, _options: unknown, run: (lock: object | null) => unknown) => run(lockHeldElsewhere ? null : {}) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("waits for the page to settle, then runs a bounded pass that leaves fresh uploads alone", async () => {
    const stop = startPendingRenditions();
    await tick(FIRST_CHECK_MS - 1);
    expect(engine.renderPendingRenditions).not.toHaveBeenCalled();

    await tick(1);
    expect(engine.renderPendingRenditions).toHaveBeenCalledTimes(1);
    expect(engine.renderPendingRenditions).toHaveBeenCalledWith(expect.objectContaining({
      limit: PASS_LIMIT, minAgeMs: UPLOAD_GRACE_MS,
    }));
    stop();
  });

  it("keeps passing while images render, then rests until the next check", async () => {
    engine.renderPendingRenditions
      .mockResolvedValueOnce({ rendered: 10, failed: 0, more: true })
      .mockResolvedValueOnce({ rendered: 3, failed: 0, more: false });
    const stop = startPendingRenditions();
    await tick(FIRST_CHECK_MS);
    await tick(2_000);
    expect(engine.renderPendingRenditions).toHaveBeenCalledTimes(2);

    await tick(RECHECK_MS - 1);
    expect(engine.renderPendingRenditions).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(engine.renderPendingRenditions).toHaveBeenCalledTimes(3);
    stop();
  });

  it("does not hammer when nothing could be rendered", async () => {
    engine.renderPendingRenditions.mockResolvedValue({ rendered: 0, failed: 10, more: true });
    const stop = startPendingRenditions();
    await tick(FIRST_CHECK_MS);
    await tick(RECHECK_MS - 1);
    expect(engine.renderPendingRenditions).toHaveBeenCalledTimes(1);
    stop();
  });

  it("yields to another tab that holds the lock", async () => {
    lockHeldElsewhere = true;
    const stop = startPendingRenditions();
    await tick(FIRST_CHECK_MS);
    expect(engine.renderPendingRenditions).not.toHaveBeenCalled();
    stop();
  });

  it("works only while the tab is visible and resumes when it returns", async () => {
    visibility = "hidden";
    const stop = startPendingRenditions();
    await tick(FIRST_CHECK_MS);
    expect(engine.renderPendingRenditions).not.toHaveBeenCalled();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await tick(FIRST_CHECK_MS);
    expect(engine.renderPendingRenditions).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops after the session limit and when the page unmounts", async () => {
    engine.renderPendingRenditions.mockResolvedValue({ rendered: SESSION_LIMIT, failed: 0, more: true });
    const stop = startPendingRenditions();
    await tick(FIRST_CHECK_MS);
    await tick(2_000);
    expect(engine.renderPendingRenditions).toHaveBeenCalledTimes(1);

    stop();
    await tick(RECHECK_MS * 2);
    expect(engine.renderPendingRenditions).toHaveBeenCalledTimes(1);
  });

  it("survives a failing pass and tries again at the next check", async () => {
    engine.renderPendingRenditions.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ rendered: 0, failed: 0, more: false });
    const stop = startPendingRenditions();
    await tick(FIRST_CHECK_MS);
    await tick(RECHECK_MS);
    expect(engine.renderPendingRenditions).toHaveBeenCalledTimes(2);
    stop();
  });
});
