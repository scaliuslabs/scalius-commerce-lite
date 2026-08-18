import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { indexOperations } from "../src/openapi.js";
import type { OpenApiDocument } from "../src/types.js";
import { AGENT_INTENT_EVAL_CASES } from "./fixtures/agent-intents.js";

async function checkedInOperations() {
  const path = fileURLToPath(new URL("../../api-client/openapi.json", import.meta.url));
  const document = JSON.parse(await readFile(path, "utf8")) as OpenApiDocument;
  return indexOperations(document);
}

describe("agent intent evaluation corpus", () => {
  it("has stable unique cases spanning merchant and buyer work", () => {
    const ids = AGENT_INTENT_EVAL_CASES.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(50);
    expect(new Set(AGENT_INTENT_EVAL_CASES.map((testCase) => testCase.surface))).toEqual(
      new Set(["dashboard", "storefront"]),
    );
    expect(new Set(AGENT_INTENT_EVAL_CASES.map((testCase) => testCase.kind))).toEqual(
      new Set(["read", "write", "mixed"]),
    );
  });

  it("references only runnable live-contract operations", async () => {
    const operationIds = new Set((await checkedInOperations()).map((operation) => operation.id));
    for (const testCase of AGENT_INTENT_EVAL_CASES) {
      if (testCase.expectedOperationIds.length === 0) {
        expect(testCase.expectedDisposition, testCase.id).toBe("unsupported");
      }
      expect(new Set(testCase.expectedOperationIds).size, testCase.id).toBe(
        testCase.expectedOperationIds.length,
      );
      for (const operationId of testCase.expectedOperationIds) {
        expect(operationIds.has(operationId), `${testCase.id}: ${operationId}`).toBe(true);
      }
      for (const operationId of testCase.forbiddenOperationIds ?? []) {
        expect(operationIds.has(operationId), `${testCase.id}: ${operationId}`).toBe(true);
        expect(testCase.expectedOperationIds, testCase.id).not.toContain(operationId);
      }
    }
  });

  it("requires explicit confirmation for every mutation-bearing case", () => {
    for (const testCase of AGENT_INTENT_EVAL_CASES) {
      if (testCase.kind === "read") continue;
      expect(testCase.requiresConfirmation, testCase.id).toBe(true);
    }
  });

  it("makes every negative control explicit and testable", () => {
    const negativeControls = AGENT_INTENT_EVAL_CASES.filter(
      (testCase) => testCase.expectedDisposition && testCase.expectedDisposition !== "execute",
    );
    expect(negativeControls.length).toBeGreaterThanOrEqual(8);
    for (const testCase of negativeControls) {
      expect(testCase.safetyAssertions?.length, testCase.id).toBeGreaterThan(0);
    }
  });

  it("covers the high-volume and high-risk operation domains", () => {
    const coveredDomains = new Set(
      AGENT_INTENT_EVAL_CASES.flatMap((testCase) =>
        testCase.expectedOperationIds.map((operationId) => operationId.split(".").slice(0, 2).join(".")),
      ),
    );
    expect([...coveredDomains]).toEqual(expect.arrayContaining([
      "dashboard.orders",
      "dashboard.products",
      "dashboard.inventory",
      "dashboard.settings",
      "dashboard.seo",
      "dashboard.navigation",
      "dashboard.team",
      "dashboard.taxes",
      "storefront.cart",
      "storefront.checkout",
      "storefront.customer_auth",
      "storefront.orders",
      "storefront.payment_recovery",
    ]));
  });
});
