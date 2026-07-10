import {
  SCALIUS_COMMAND_API_ORIGIN,
  SCALIUS_COMMAND_API_PATHS,
  SCALIUS_COMMAND_MAX_RESPONSE_BYTES,
  type ScaliusCommandApiBinding,
} from "@scalius/shared/assistant-command-client";
import { describe, expect, it, vi } from "vitest";
import { createAdminScaliusTool } from "./scalius";

const INSTANCE_ID = `v1.${"a".repeat(43)}`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

describe("Admin scalius tool", () => {
  it("sends one validated program and only the opaque instance to the exact API authority path", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      success: true,
      data: { kind: "capability_result", products: [{ id: "prod_1", title: "Trail shoe" }] },
    }));
    const tool = createAdminScaliusTool(INSTANCE_ID, { fetch });

    expect(tool.name).toBe("scalius");
    expect(tool.input).toBeDefined();
    expect(tool.output).toBeDefined();
    expect(tool.description.length).toBeLessThan(700);
    const result = await tool.run({
      input: { program: 'call admin.api.get.products -- {"page":1}' },
    });

    expect(result).toEqual({
      ok: true,
      authoritative: true,
      code: "ok",
      message: "Authoritative Scalius result received.",
      retryable: false,
      data: { kind: "capability_result", products: [{ id: "prod_1", title: "Trail shoe" }] },
    });
    expect(result).not.toHaveProperty("instanceId");
    expect(fetch).toHaveBeenCalledOnce();
    const [target, init] = fetch.mock.calls[0] ?? [];
    expect(target).toBe(`${SCALIUS_COMMAND_API_ORIGIN}${SCALIUS_COMMAND_API_PATHS.admin}`);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(init?.body))).toEqual({
      instanceId: INSTANCE_ID,
      program: 'call admin.api.get.products -- {"page":1}',
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-scalius-tenant-id")).toBeNull();
    expect(headers.get("x-scalius-principal-id")).toBeNull();
    expect(headers.get("x-scalius-thread-id")).toBeNull();
  });

  it("rejects approval, raw transport, code, and secret-shaped programs before transport", async () => {
    const fetch = vi.fn(async () => jsonResponse({ success: true, data: {} }));
    const tool = createAdminScaliusTool(INSTANCE_ID, { fetch });
    const programs = [
      "confirm action_1",
      "GET /api/v1/admin/products",
      "call https://evil.example -- {}",
      "shell rm -rf /",
      "sql SELECT * FROM orders",
      'prepare admin.settings.update -- {"otpCode":"123456"}',
    ];
    for (const program of programs) {
      await expect(tool.run({ input: { program } })).resolves.toMatchObject({
        ok: false,
        authoritative: false,
        code: "invalid_program",
        retryable: false,
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when the binding, instance, or service is unavailable without retrying", async () => {
    await expect(createAdminScaliusTool(INSTANCE_ID).run({ input: { program: "help" } }))
      .resolves.toEqual({
        ok: false,
        authoritative: false,
        code: "scalius_unavailable",
        message: "Scalius is temporarily unavailable.",
        retryable: true,
      });

    const fetch = vi.fn(async () => {
      throw new Error("do not expose this internal error");
    });
    await expect(createAdminScaliusTool("not-an-instance", { fetch }).run({
      input: { program: "help" },
    })).resolves.toMatchObject({ code: "scalius_unavailable", authoritative: false });
    expect(fetch).not.toHaveBeenCalled();

    await expect(createAdminScaliusTool(INSTANCE_ID, { fetch }).run({
      input: { program: "help" },
    })).resolves.toEqual({
      ok: false,
      authoritative: false,
      code: "scalius_unavailable",
      message: "Scalius is temporarily unavailable.",
      retryable: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves only an exact bounded API-owned error envelope", async () => {
    const accepted: ScaliusCommandApiBinding = {
      fetch: async () => jsonResponse({
        success: false,
        error: {
          code: "permission_denied",
          message: "You do not have permission for this capability.",
          retryable: false,
        },
      }, 403),
    };
    await expect(createAdminScaliusTool(INSTANCE_ID, accepted).run({
      input: { program: "call admin.api.get.orders -- {}" },
    })).resolves.toEqual({
      ok: false,
      authoritative: true,
      code: "permission_denied",
      message: "You do not have permission for this capability.",
      retryable: false,
    });

    for (const error of [
      { code: "permission_denied", message: "Bearer token leaked", retryable: false },
      { code: "permission-denied", message: "Denied.", retryable: false },
      { code: "permission_denied", message: "Denied.", retryable: false, tenantId: "tenant_1" },
    ]) {
      const api = { fetch: async () => jsonResponse({ success: false, error }, 403) };
      await expect(createAdminScaliusTool(INSTANCE_ID, api).run({
        input: { program: "call admin.api.get.orders -- {}" },
      })).resolves.toMatchObject({
        ok: false,
        authoritative: false,
        code: "scalius_invalid_response",
      });
    }
  });

  it("rejects malformed, identity-bearing, and oversized responses", async () => {
    const responses = [
      new Response("not-json", { headers: { "Content-Type": "application/json" } }),
      new Response("{}", { headers: { "Content-Type": "text/plain" } }),
      jsonResponse({ success: true, data: {}, extra: true }),
      jsonResponse({ success: true, data: { tenantId: "tenant_1" } }),
      jsonResponse({
        success: true,
        data: { text: "x".repeat(SCALIUS_COMMAND_MAX_RESPONSE_BYTES) },
      }),
      jsonResponse({ success: true, data: {} }, 503),
    ];
    for (const response of responses) {
      const fetch = vi.fn(async () => response);
      await expect(createAdminScaliusTool(INSTANCE_ID, { fetch }).run({
        input: { program: "help" },
      })).resolves.toMatchObject({
        ok: false,
        authoritative: false,
        code: "scalius_invalid_response",
      });
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it("aborts one slow authority request at the bounded deadline", async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    const result = await createAdminScaliusTool(INSTANCE_ID, { fetch }, { timeoutMs: 10 }).run({
      input: { program: "find products" },
    });
    expect(result).toEqual({
      ok: false,
      authoritative: false,
      code: "scalius_timeout",
      message: "Scalius did not respond in time.",
      retryable: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
