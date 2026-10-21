// Members (`acme.members`): app customer roles and a background job, on the
// public plugin contract only.
//
// - Roles: an import gives customers the app's `member` role
//   (`ctx.customers.roles`, needs read_customers); a member-only cart rule
//   reads `cart.customer.roles` (its own roles only, no read of its own).
// - Jobs: the dashboard's Import button starts `import_members`
//   (`ctx.jobs.start`, idempotent by key), which grants the role two
//   customers per step and reports progress; the page shows it with a live
//   `ui.progress`. `flaky` fails on purpose (tests of retries and refusals).

import { definePlugin, PLUGIN_API_VERSION, ui, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.members",
  name: "Members",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Gives customers a member role, imports members in the background and keeps checkout for members.",
  author: { name: "Acme" },
  scopes: ["read_customers"],
  functions: [{ point: "cart.validate", priority: 100 }],
  routes: {
    admin: [{ name: "import", methods: ["GET", "POST"], description: "The member import and its progress." }],
  },
  jobs: [
    { name: "import_members", title: "Import members" },
    { name: "flaky", title: "A step that fails" },
  ],
} satisfies PluginManifestInput;

/** Customers one step grants the role to. */
export const MEMBERS_PER_STEP = 2;

export default definePlugin({
  manifest,
  functions: {
    "cart.validate": (input) => {
      const member = input.cart.customer?.roles.some((entry) => entry.role === "member") ?? false;
      return { errors: member ? [] : [{ code: "members_only", message: "This store sells to members only." }] };
    },
  },
  routes: {
    admin: {
      import: async (request, ctx) => {
        if (request.method === "POST") {
          const body = (request.body ?? {}) as { customers?: unknown; key?: unknown };
          const customers = Array.isArray(body.customers) ? body.customers.filter((id): id is string => typeof id === "string") : [];
          const job = await ctx.jobs.start("import_members", { input: { customers }, ...(typeof body.key === "string" ? { key: body.key } : {}) });
          return { body: { job, ...ui.result({ toast: "Import started", refresh: true }) } };
        }
        const [job] = await ctx.jobs.list({ name: "import_members", limit: 1 });
        return {
          body: ui.page([
            job
              ? ui.progress("Importing members", job.progress.done, Math.max(1, job.progress.total), { live: job.status === "running", ...(job.message ? { help: job.message } : {}) })
              : ui.empty("No import yet"),
          ], { title: "Members" }),
        };
      },
    },
  },
  jobs: {
    import_members: async (ctx, job) => {
      const customers = ((job.input ?? {}) as { customers?: string[] }).customers ?? [];
      const offset = ((job.state ?? {}) as { offset?: number }).offset ?? 0;
      const batch = customers.slice(offset, offset + MEMBERS_PER_STEP);
      for (const customerId of batch) await ctx.customers.roles.grant(customerId, "member", { ref: `import_${job.id.slice(-8)}` });
      const done = offset + batch.length;
      return { state: { offset: done }, progress: { done, total: customers.length }, message: `${done} of ${customers.length} imported`, done: done >= customers.length };
    },
    flaky: async (_ctx, job) => {
      const mode = ((job.input ?? {}) as { mode?: string }).mode;
      if (mode === "throw") throw new Error("The step broke.");
      if (mode === "invalid") return { done: "yes" } as never;
      return { done: true };
    },
  },
});
