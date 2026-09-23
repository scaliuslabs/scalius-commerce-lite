import { describe, expect, it } from "vitest";
import { orderEditMode } from "./-order-form-route-state";

const allowed = { allowed: true, reason: null };
const blocked = (reason: string) => ({ allowed: false, reason });

describe("order edit mode", () => {
  it("uses the full editor when the server allows it", () => {
    expect(orderEditMode({
      fullEditReadiness: allowed,
      amendmentReadiness: blocked("Only manual COD orders"),
    })).toEqual({ mode: "edit" });
  });

  it("uses the quote-backed amendment when only that is allowed", () => {
    expect(orderEditMode({
      fullEditReadiness: blocked("Has a tax snapshot"),
      amendmentReadiness: allowed,
    })).toEqual({ mode: "amend" });
  });

  it("locks the order with the server's reason when neither is allowed", () => {
    expect(orderEditMode({
      fullEditReadiness: blocked("Already shipped"),
      amendmentReadiness: blocked("Past the amendment window"),
    })).toEqual({ mode: "locked", reason: "Already shipped" });
    expect(orderEditMode({
      fullEditReadiness: { allowed: false, reason: null },
      amendmentReadiness: blocked("Past the amendment window"),
    })).toEqual({ mode: "locked", reason: "Past the amendment window" });
  });
});
