import { describe, expect, it, vi } from "vitest";
import { REQUIRED_STATE_RULES, runInteractions } from "./interactions.mjs";

function locator(overrides = {}) {
  let value = "";
  const target = {
    first() { return target; },
    waitFor: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    selectOption: vi.fn(async (next) => { value = next; }),
    fill: vi.fn(async (next) => { value = next; }),
    pressSequentially: vi.fn(async (next) => { value += next; }),
    inputValue: vi.fn(async () => value),
    ...overrides,
  };
  return target;
}
function pageFor(targets) {
  return { locator: vi.fn((selector) => targets[selector] ?? locator({ waitFor: vi.fn(async () => { throw new Error(`Missing ${selector}`); }) })) };
}
const open = { click: "#menu", expectVisible: '#drawer[aria-hidden="false"]', maxWidth: 1024 };

describe("required gallery interactions", () => {
  it("records intentional width exclusions without looking for the control", async () => {
    const page = pageFor({});
    const result = await runInteractions(page, [open], 1024);
    expect(result).toEqual({ steps: [{ index: 0, selector: "#menu", status: "not-applicable" }], failure: null });
    expect(page.locator).not.toHaveBeenCalled();
  });

  it.each(["missing", "hidden"])("fails a %s required control instead of skipping it", async (state) => {
    const target = locator({ waitFor: vi.fn(async () => { throw new Error(state); }) });
    const result = await runInteractions(pageFor({ "#menu": target }), [open], 390);
    expect(result.failure).toMatchObject({ rule: "interaction", gating: true, nodes: ["#menu"] });
    expect(result.failure.message).toContain(state);
    expect(target.click).not.toHaveBeenCalled();
  });

  it("stops after a failed click and distinguishes unrun from excluded actions", async () => {
    const target = locator({ click: vi.fn(async () => { throw new Error("obscured"); }) });
    const result = await runInteractions(pageFor({ "#menu": target }), [open,
      { type: "#search", text: "shirts" }, { ...open, maxWidth: 320 }], 390);
    expect(result.steps.map((step) => step.status)).toEqual(["failed", "not-run", "not-applicable"]);
    expect(result.failure.message).toContain("obscured");
  });

  it("rejects a click that resolved without opening its intended drawer", async () => {
    const target = locator();
    const result = await runInteractions(pageFor({ "#menu": target }), [open], 390);
    expect(target.click).toHaveBeenCalledOnce();
    expect(result.failure.message).toContain("#drawer");
  });

  it("requires click declarations to state their intended result", async () => {
    const page = pageFor({ "#menu": locator() });
    const result = await runInteractions(page, [{ click: "#menu" }], 390);
    expect(result.failure.message).toContain("expected visible state");
    expect(page.locator).not.toHaveBeenCalled();
  });

  it("passes only after the expected drawer becomes visible", async () => {
    const drawer = locator();
    const result = await runInteractions(pageFor({ "#menu": locator(), [open.expectVisible]: drawer }), [open], 390);
    expect(result.failure).toBeNull();
    expect(result.steps[0].status).toBe("passed");
    expect(drawer.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 5000 });
  });

  it("checks a selection's persisted value, not just the select promise", async () => {
    const target = locator({ inputValue: vi.fn(async () => "BD") });
    const result = await runInteractions(pageFor({ "#country": target }), [{ select: "#country", value: "GB" }], 390);
    expect(result.failure.message).toContain("Selected value did not persist");
  });

  it("requires the selected country's fields to appear", async () => {
    const result = await runInteractions(pageFor({ "#country": locator() }), [
      { select: "#country", value: "GB", expectVisible: "#postcode" },
    ], 390);
    expect(result.failure.message).toContain("#postcode");
  });

  it("clears a restored search query and requires suggestions after typing", async () => {
    const input = locator();
    await input.fill("old query");
    const result = await runInteractions(pageFor({ "#address": input, "#suggestions": locator() }), [
      { type: "#address", text: "10 Down", expectVisible: "#suggestions" },
    ], 390);
    expect(result.failure).toBeNull();
    expect(await input.inputValue()).toBe("10 Down");
    expect(input.fill).toHaveBeenLastCalledWith("", { timeout: 5000 });
  });

  it("fails when typed text does not persist", async () => {
    const input = locator({ inputValue: vi.fn(async () => "") });
    const result = await runInteractions(pageFor({ "#address": input }), [{ type: "#address", text: "10 Down" }], 390);
    expect(result.failure.message).toContain("Typed value did not persist");
  });

  it("marks both missing regions and failed interactions as invalid audit states", () => {
    expect([...REQUIRED_STATE_RULES]).toEqual(["interaction", "focus-missing"]);
  });
});
