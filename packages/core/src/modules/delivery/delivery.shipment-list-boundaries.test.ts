import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./delivery.service.ts", import.meta.url), "utf8");

describe("shipment list query boundaries", () => {
  it("joins provider display data in one bounded query", () => {
    const start = source.indexOf("export async function getShipments");
    const end = source.indexOf("export async function checkShipmentStatus", start);
    const helper = source.slice(start, end);

    expect(source).toContain("export const ORDER_SHIPMENT_LIST_LIMIT = 100");
    expect(helper).toContain("getTableColumns(deliveryShipments)");
    expect(helper).toContain(".leftJoin(");
    expect(helper).toContain("providerName: deliveryProviders.name");
    expect(helper).toContain(".limit(ORDER_SHIPMENT_LIST_LIMIT)");
  });
});
