import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthOtpQueueMessage } from "../queue-consumer";
import { enqueueAuthOtp, type OtpHandoffContext } from "./otp-queue";

const delivered = vi.hoisted(() => ({ deliverAuthOtpDirect: vi.fn(async () => undefined) }));
vi.mock("../queue-consumer", () => ({ deliverAuthOtpDirect: delivered.deliverAuthOtpDirect }));

const payload = {
  type: "auth.send_otp",
  challengeKey: "challenge",
  deliveryKey: "otp_delivery_1",
  method: "email",
  allowedMethod: "email",
  channel: "email",
} as AuthOtpQueueMessage;

function context(send: () => Promise<void>, withExecutionContext = true) {
  const tasks: Promise<unknown>[] = [];
  const db = { id: "db" };
  const c = {
    env: { JOBS_QUEUE: { send: vi.fn(send) } } as unknown as Env,
    get: () => db,
    ...(withExecutionContext ? { executionCtx: { waitUntil: (task: Promise<unknown>) => { tasks.push(task); } } } : {}),
  } as unknown as OtpHandoffContext;
  // Hono throws when there is no execution context; so does this stand-in.
  if (!withExecutionContext) Object.defineProperty(c, "executionCtx", { get() { throw new Error("no execution context"); } });
  return { c, tasks, db };
}

afterEach(() => vi.clearAllMocks());

describe("OTP queue handoff", () => {
  it("queues the message and delivers nothing directly", async () => {
    const { c, tasks } = context(async () => undefined);
    expect(await enqueueAuthOtp(c, payload)).toBe("queued");
    expect(c.env.JOBS_QUEUE.send).toHaveBeenCalledWith(payload);
    expect(tasks).toHaveLength(0);
    expect(delivered.deliverAuthOtpDirect).not.toHaveBeenCalled();
  });

  it("delivers directly, after the response, when the queue refuses it (binding down, daily operations spent)", async () => {
    const { c, tasks, db } = context(async () => { throw new Error("Queue send failed: operations limit exceeded"); });
    expect(await enqueueAuthOtp(c, payload)).toBe("direct");
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    expect(delivered.deliverAuthOtpDirect).toHaveBeenCalledWith(payload, db, c.env);
  });

  it("keeps a failed direct delivery from failing the request, and logs its class only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    delivered.deliverAuthOtpDirect.mockRejectedValueOnce(new Error("provider said buyer@example.com is unreachable"));
    const { c, tasks } = context(async () => { throw new TypeError("queue down"); });
    expect(await enqueueAuthOtp(c, payload)).toBe("direct");
    await expect(Promise.all(tasks)).resolves.toBeDefined();
    expect(JSON.stringify(error.mock.calls)).not.toContain("buyer@example.com");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("buyer@example.com");
    error.mockRestore();
    warn.mockRestore();
  });

  it("rethrows the queue's error when there is no execution context to keep the delivery alive", async () => {
    const { c } = context(async () => { throw new Error("queue down"); }, false);
    await expect(enqueueAuthOtp(c, payload)).rejects.toThrow("queue down");
    expect(delivered.deliverAuthOtpDirect).not.toHaveBeenCalled();
  });

  it("delivers directly when the binding is missing altogether", async () => {
    const { c, tasks } = context(async () => undefined);
    (c.env as unknown as { JOBS_QUEUE: unknown }).JOBS_QUEUE = undefined;
    expect(await enqueueAuthOtp(c, payload)).toBe("direct");
    await Promise.all(tasks);
    expect(delivered.deliverAuthOtpDirect).toHaveBeenCalledTimes(1);
  });
});
