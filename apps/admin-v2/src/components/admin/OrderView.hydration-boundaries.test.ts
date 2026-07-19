import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./OrderView.tsx", import.meta.url), "utf8");
const paymentCardSource = readFileSync(
  new URL("./orderview/PaymentCard.tsx", import.meta.url),
  "utf8",
);

describe("order detail hydration boundary", () => {
  it("renders route-owned panels directly so server and first client render agree", () => {
    expect(source).not.toContain("lazy(");
    expect(source).not.toContain("<Suspense");
    expect(source).toContain('import { OrderReturnsCard } from "./orderview/OrderReturnsCard";');
    expect(source).toContain('import { OrderNotificationsCard } from "./orderview/OrderNotificationsCard";');
  });

  it("does not render optional payment-query data before hydration", () => {
    expect(paymentCardSource).toContain(
      "const paymentsResult = isHydrated",
    );
    expect(paymentCardSource).toContain(
      "const paymentHistoryFetching = isHydrated && paymentsFetching;",
    );
    expect(paymentCardSource).not.toContain("disabled={paymentsFetching}");
  });
});
