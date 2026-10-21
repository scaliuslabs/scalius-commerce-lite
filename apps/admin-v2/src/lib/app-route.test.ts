import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "./admin-api-error";
import { APP_ROUTE_BAD_ANSWER, appRoutePath, fetchAppDocument, fetchAppRoute } from "./app-route";

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

const answer = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status }));

afterEach(() => fetchMock.mockReset());

describe("app route transport", () => {
  it("addresses the app's own admin route, with plain sub paths and the query", async () => {
    answer(200, { ok: true });
    await fetchAppRoute("acme.app", "orders", { subpath: "a b/c", query: { cursor: "n1", surface: "x" } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(appRoutePath("acme.app", "orders")).toBe("/api/v1/plugins/acme.app/admin/orders");
    expect(url).toBe("/api/v1/plugins/acme.app/admin/orders/a%20b/c?cursor=n1&surface=x");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
    expect(init.body).toBeUndefined();
  });

  it("returns the app's raw JSON on success: no envelope is unwrapped", async () => {
    // An app body that happens to carry `data` stays as the app sent it.
    answer(200, { version: 1, data: { kept: true } });
    await expect(fetchAppRoute("acme.app", "dashboard")).resolves.toEqual({ status: 200, ok: true, body: { version: 1, data: { kept: true } } });
  });

  it("sends JSON bodies for actions", async () => {
    answer(200, { toast: { message: "Done" } });
    await fetchAppRoute("acme.app", "wave", { method: "POST", body: { resource: "product", ids: ["p1"], action: "wave" } });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ resource: "product", ids: ["p1"], action: "wave" });
  });

  it("keeps an app's own unsuccessful answer (a 422 with a toast) as its answer", async () => {
    answer(422, { toast: { message: "Select at least one product.", tone: "critical" } });
    await expect(fetchAppRoute("acme.app", "wave", { method: "POST", body: {} })).resolves.toEqual({
      status: 422,
      ok: false,
      body: { toast: { message: "Select at least one product.", tone: "critical" } },
    });
  });

  it("throws the platform's failure envelope with its code and the app's masked reason", async () => {
    answer(504, { success: false, error: { code: "app_timeout", message: "The app took too long to answer." } });
    const error = await fetchAppRoute("acme.app", "dashboard").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdminApiResponseError);
    expect(error).toMatchObject({ status: 504, code: "app_timeout", message: "The app took too long to answer." });
  });

  it("refuses an answer that is not JSON", async () => {
    answer(200, "<html>nope</html>");
    await expect(fetchAppRoute("acme.app", "dashboard")).rejects.toMatchObject({ code: APP_ROUTE_BAD_ANSWER });
  });

  it("reads a document only from a 2xx answer", async () => {
    answer(404, { error: "missing" });
    await expect(fetchAppDocument("acme.app", "dashboard")).rejects.toMatchObject({ status: 404, code: APP_ROUTE_BAD_ANSWER });
    answer(200, { version: 1, root: { type: "divider" } });
    await expect(fetchAppDocument("acme.app", "dashboard")).resolves.toEqual({ version: 1, root: { type: "divider" } });
  });
});
