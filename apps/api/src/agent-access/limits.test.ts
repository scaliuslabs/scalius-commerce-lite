import { describe, expect, it, vi } from "vitest";
import {
  AGENT_MAX_REQUEST_BODY_BYTES,
  AgentPayloadTooLargeError,
  AgentRequestLengthMismatchError,
  bufferBoundedAgentRequest,
  checkAgentRateLimit,
  withAgentNoStoreHeaders,
} from "./limits";

describe("agent request limits", () => {
  it("rejects declared and streamed bodies over 1 MiB", async () => {
    const declared = new Request("https://api.example.test/oauth/token", {
      method: "POST",
      headers: { "Content-Length": String(AGENT_MAX_REQUEST_BODY_BYTES + 1) },
      body: "x",
    });
    await expect(bufferBoundedAgentRequest(declared)).rejects.toBeInstanceOf(
      AgentPayloadTooLargeError,
    );

    const streamed = new Request("https://api.example.test/api/v1/mcp/dashboard", {
      method: "POST",
      body: new Uint8Array(AGENT_MAX_REQUEST_BODY_BYTES + 1),
    });
    await expect(bufferBoundedAgentRequest(streamed)).rejects.toBeInstanceOf(
      AgentPayloadTooLargeError,
    );
  });

  it("uses a dynamic operation ceiling and reconstructs one downstream body", async () => {
    const request = new Request("https://api.example.test/direct", {
      method: "POST",
      body: new Uint8Array([1, 2, 3, 4]),
    });
    const bounded = await bufferBoundedAgentRequest(request, 4);
    expect(bounded.headers.get("Content-Length")).toBe("4");
    expect([...new Uint8Array(await bounded.arrayBuffer())]).toEqual([1, 2, 3, 4]);

    await expect(bufferBoundedAgentRequest(new Request(
      "https://api.example.test/direct",
      { method: "POST", body: new Uint8Array(5) },
    ), 4)).rejects.toMatchObject({ maxBytes: 4 });
  });

  it.each([
    { declared: 3, actual: 4 },
    { declared: 5, actual: 4 },
  ])("rejects declared length $declared when the stream contains $actual bytes", async ({
    declared,
    actual,
  }) => {
    const request = new Request("https://api.example.test/direct", {
      method: "POST",
      headers: { "Content-Length": String(declared) },
      body: new Uint8Array(actual),
    });
    await expect(bufferBoundedAgentRequest(request, 8)).rejects.toBeInstanceOf(
      AgentRequestLengthMismatchError,
    );
  });

  it("fails closed when the dedicated limiter is absent", async () => {
    await expect(checkAgentRateLimit({} as Env, "grant:test")).resolves.toBe(false);
    const limit = vi.fn().mockResolvedValue({ success: true });
    await expect(checkAgentRateLimit({ AGENT_RATE_LIMITER: { limit } } as unknown as Env, "grant:test"))
      .resolves.toBe(true);
    expect(limit).toHaveBeenCalledWith({ key: "grant:test" });
  });

  it("forces every response private and no-store", () => {
    const response = withAgentNoStoreHeaders(new Response("ok", {
      headers: { "Cache-Control": "public, max-age=3600", "CDN-Cache-Control": "public" },
    }));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.has("CDN-Cache-Control")).toBe(false);
  });
});
