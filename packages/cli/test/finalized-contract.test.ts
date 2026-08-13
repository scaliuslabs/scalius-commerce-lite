import { describe, expect, it } from "vitest";
import { indexOperations } from "../src/openapi.js";
import type { OpenApiDocument } from "../src/types.js";

describe("finalized API OpenAPI interop", () => {
  it("indexes every executable and continuation operation from the in-memory finalized application contract", async () => {
    const appModulePath = new URL("../../../apps/api/src/app.ts", import.meta.url).href;
    const contractModulePath = new URL("../../../apps/api/src/openapi-contract.ts", import.meta.url).href;
    const manifestModulePath = new URL("../../../apps/api/src/generated/agent-operations.gen.ts", import.meta.url).href;
    const [appModule, contractModule, manifestModule] = await Promise.all([
      import(/* @vite-ignore */ appModulePath),
      import(/* @vite-ignore */ contractModulePath),
      import(/* @vite-ignore */ manifestModulePath),
    ]);
    const app = appModule.default as {
      getOpenAPIDocument: (options: Record<string, unknown>) => unknown;
    };
    const finalizeOpenApiContract = contractModule.finalizeOpenApiContract as (document: unknown) => unknown;
    const document = finalizeOpenApiContract(app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Scalius CLI finalized-contract proof", version: "test" },
    })) as OpenApiDocument;

    const operations = indexOperations(document);
    const runnableCount = Object.values(document.paths ?? {}).reduce((count, pathItem) => {
      if (!pathItem || typeof pathItem !== "object") return count;
      return count + Object.values(pathItem).filter((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
        const metadata = (candidate as Record<string, unknown>)["x-scalius-agent"];
        return Boolean(metadata) && typeof metadata === "object" &&
          ["execute", "continuation"].includes(String((metadata as Record<string, unknown>).exposure));
      }).length;
    }, 0);

    expect(operations).toHaveLength(runnableCount);
    const cliOperationIds = operations.map(({ id }) => id).sort();
    const mcpOperationIds = (manifestModule.AGENT_OPERATIONS as Array<{
      operationId: string;
      exposure: string;
    }>)
      .filter(({ exposure }) => exposure === "execute" || exposure === "continuation")
      .map(({ operationId }) => operationId)
      .sort();
    expect(cliOperationIds).toEqual(mcpOperationIds);
    expect(operations.some(({ agent }) => agent.openWorld === true)).toBe(true);
    expect(operations.some(({ agent }) => agent.openWorld === false)).toBe(true);
    expect(operations.every(({ agent }) =>
      Number.isSafeInteger(agent.maxRequestBytes) &&
      agent.maxRequestBytes! >= 1 &&
      agent.maxRequestBytes! <= 16 * 1024 * 1024
    )).toBe(true);

    for (const operation of operations) {
      const pathItem = document.paths![operation.path]!;
      const raw = pathItem[operation.method.toLowerCase()] as Record<string, unknown>;
      const rawMetadata = raw["x-scalius-agent"] as Record<string, unknown>;
      expect(operation.agent.maxRequestBytes).toBe(rawMetadata.maxRequestBytes);
    }
    expect(operations.find(({ id }) => id === "dashboard.media.upload_part")?.agent.maxRequestBytes)
      .toBe(5 * 1024 * 1024);
    expect(operations.filter(({ agent }) => agent.exposure === "continuation").map(({ id }) => id))
      .toEqual([
        "dashboard.theme.preview_session_create",
        "storefront.continuations.get",
        "storefront.customer_auth.begin",
        "storefront.customer_auth.status",
        "storefront.orders.payment.begin",
        "storefront.payment_recovery.begin",
        "storefront.payment_recovery.status",
        "storefront.payment.status",
      ]);
    expect(operations.find(({ id }) => id === "dashboard.theme.preview_session_create")?.agent.continuationOutput)
      .toEqual(expect.objectContaining({ sensitiveFields: ["continuationCode"] }));
  }, 15_000);
});
