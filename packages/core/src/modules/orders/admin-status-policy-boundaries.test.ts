import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fulfillmentSource = readFileSync(
  fileURLToPath(new URL("./orders.fulfillment.ts", import.meta.url)),
  "utf8",
);
const adminSource = readFileSync(
  fileURLToPath(new URL("./orders.admin.ts", import.meta.url)),
  "utf8",
);

describe("generic order status mutation boundaries", () => {
  it("applies the narrow policy before the internal graph in the status route", () => {
    const policy = fulfillmentSource.indexOf(
      "assertGenericAdminOrderStatusTransition(currentStatus, nextStatus)",
    );
    const graph = fulfillmentSource.indexOf(
      'validateTransition("order", currentStatus, nextStatus)',
      policy,
    );
    expect(policy).toBeGreaterThan(0);
    expect(graph).toBeGreaterThan(policy);
  });

  it("applies the same narrow policy to full admin order edits", () => {
    const policy = adminSource.indexOf(
      "assertGenericAdminOrderStatusTransition(currentStatus, nextStatus)",
    );
    const graph = adminSource.indexOf(
      'validateTransition("order", currentStatus, nextStatus)',
      policy,
    );
    expect(policy).toBeGreaterThan(0);
    expect(graph).toBeGreaterThan(policy);
  });
});
