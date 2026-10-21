import { describe, expect, it } from "vitest";
import { createPluginTestHarness, fixtures, parsePluginUiDocument } from "@scalius/plugin-sdk/testing";
import members from "./index";

describe("acme.members", () => {
  it("imports members in a background job, step by step, with progress the page shows live", async () => {
    const harness = createPluginTestHarness(members, { customers: ["c1", "c2", "c3"] });
    const { job, steps } = await harness.runJob("import_members", { input: { customers: ["c1", "c2", "c3"] } });
    expect(job).toMatchObject({ name: "import_members", status: "done", progress: { done: 3, total: 3 }, steps: 2, message: "3 of 3 imported", error: null });
    expect(steps.map((step) => step.job.progress.done)).toEqual([2, 3]);
    expect(harness.roles("c1")).toEqual([{ role: "member", ref: expect.stringMatching(/^import_/u) }]);

    // The page reads the latest import: a finished one is no longer live.
    const page = await harness.route("admin", "import");
    const document = parsePluginUiDocument(page.value && (page.value as { body: unknown }).body);
    expect(document.ok && document.document.root).toMatchObject({ children: [{ type: "progress", value: 3, max: 3, live: false }] });
  });

  it("starts once per key from the dashboard, and a running import shows a live progress", async () => {
    const harness = createPluginTestHarness(members);
    const post = { method: "POST", body: { customers: ["c1", "c2", "c3"], key: "import-2026-10-21" } };
    const first = await harness.route("admin", "import", post);
    const again = await harness.route("admin", "import", post);
    expect((again.value as { body: { job: unknown } }).body.job).toEqual((first.value as { body: { job: unknown } }).body.job);
    expect(harness.jobs()).toHaveLength(1);
    const [job] = harness.jobs();
    await harness.jobStep(job!.id);
    const page = await harness.route("admin", "import");
    expect((page.value as { body: { root: unknown } }).body.root).toMatchObject({ children: [{ type: "progress", value: 2, max: 3, live: true, help: "2 of 3 imported" }] });
  });

  it("keeps checkout for members: the cart carries the app's own roles", async () => {
    const harness = createPluginTestHarness(members, { customers: ["c1", "c2", "c3"] });
    const member = fixtures.cart({ customer: { id: "c1", tags: [], segmentIds: [], orderCount: 0, totalSpentMinor: 0, roles: [] } });
    expect((await harness.fn("cart.validate", { cart: { ...member, customer: { ...member.customer!, roles: undefined } }, reads: {} })).value?.errors).toHaveLength(1);
    await harness.runJob("import_members", { input: { customers: ["c1"] } });
    // Left out, `roles` is what the app granted in the harness (the platform fills them per app).
    expect((await harness.fn("cart.validate", { cart: { ...member, customer: { ...member.customer!, roles: undefined } }, reads: {} })).value?.errors).toEqual([]);
  });

  it("retries a failing step and then fails the job, as the platform does", async () => {
    const harness = createPluginTestHarness(members);
    const thrown = await harness.runJob("flaky", { input: { mode: "throw" } });
    expect(thrown.job).toMatchObject({ status: "failed", error: "job_step_failed", steps: 0 });
    expect(thrown.steps).toHaveLength(3);
    const invalid = await harness.runJob("flaky", { input: { mode: "invalid" } });
    expect(invalid.job).toMatchObject({ status: "failed", error: "job_invalid_step" });
    expect(invalid.steps[0]!.result.error).toMatchObject({ code: "job_invalid_step" });
  });
});
