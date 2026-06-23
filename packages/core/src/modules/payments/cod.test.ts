import { describe, expect, it } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import { validateCODCollectionDetails } from "./cod";

describe("validateCODCollectionDetails", () => {
  const order = {
    totalAmount: 2500,
    paidAmount: 0,
    balanceDue: 2500,
  };

  it("accepts exact outstanding COD collection amounts", () => {
    expect(
      validateCODCollectionDetails(order, {
        collectedBy: "Courier A",
        collectedAmount: 2500,
      }),
    ).toMatchObject({
      collectedBy: "Courier A",
      collectedAmount: 2500,
      expectedAmount: 2500,
      newPaidAmount: 2500,
      newBalanceDue: 0,
    });
  });

  it("uses the outstanding balance for partially paid COD orders", () => {
    expect(
      validateCODCollectionDetails(
        {
          totalAmount: 2500,
          paidAmount: 500,
          balanceDue: 2000,
        },
        {
          collectedBy: "Courier A",
          collectedAmount: 2000,
        },
      ),
    ).toMatchObject({
      expectedAmount: 2000,
      newPaidAmount: 2500,
      newBalanceDue: 0,
    });
  });

  it("uses computed balance when stored balance due is stale", () => {
    expect(
      validateCODCollectionDetails(
        {
          totalAmount: 2500,
          paidAmount: 0,
          balanceDue: 0,
        },
        {
          collectedBy: "Courier A",
          collectedAmount: 2500,
        },
      ),
    ).toMatchObject({
      expectedAmount: 2500,
      newPaidAmount: 2500,
      newBalanceDue: 0,
    });
  });

  it("rejects missing collectors before any order mutation", () => {
    expect(() =>
      validateCODCollectionDetails(order, {
        collectedBy: "   ",
        collectedAmount: 2500,
      }),
    ).toThrow(ValidationError);
  });

  it("rejects non-positive or non-finite collection amounts", () => {
    expect(() =>
      validateCODCollectionDetails(order, {
        collectedBy: "Courier A",
        collectedAmount: 0,
      }),
    ).toThrow(ValidationError);

    expect(() =>
      validateCODCollectionDetails(order, {
        collectedBy: "Courier A",
        collectedAmount: Number.NaN,
      }),
    ).toThrow(ValidationError);
  });

  it("rejects under-collection and over-collection", () => {
    expect(() =>
      validateCODCollectionDetails(order, {
        collectedBy: "Courier A",
        collectedAmount: 2400,
      }),
    ).toThrow(ValidationError);

    expect(() =>
      validateCODCollectionDetails(order, {
        collectedBy: "Courier A",
        collectedAmount: 2600,
      }),
    ).toThrow(ValidationError);
  });

  it("rejects collection when no balance remains", () => {
    expect(() =>
      validateCODCollectionDetails(
        {
          totalAmount: 2500,
          paidAmount: 2500,
          balanceDue: 0,
        },
        {
          collectedBy: "Courier A",
          collectedAmount: 2500,
        },
      ),
    ).toThrow(ValidationError);
  });
});
