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
// - Uploads: the CSV import page is a form with a file field
//   (`ui.fileField`); the dashboard uploads the file first and the form
//   sends its upload id. The route hands the id to `import_csv`
//   (`ctx.jobs.start`, input `{ uploadId }`, keyed by it), whose steps read
//   the file one slice at a time (`ctx.uploads.read`, the offset in the job
//   state), grant the role to each row's customer and delete the upload
//   once the last slice is read.

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
    admin: [
      { name: "import", methods: ["GET", "POST"], description: "The member import and its progress." },
      { name: "import-csv", methods: ["GET", "POST"], description: "Import members from a CSV file." },
    ],
  },
  jobs: [
    { name: "import_members", title: "Import members" },
    { name: "import_csv", title: "Import members from a CSV file" },
    { name: "flaky", title: "A step that fails" },
  ],
} satisfies PluginManifestInput;

/** Customers one step grants the role to. */
export const MEMBERS_PER_STEP = 2;
/**
 * Bytes of the CSV one step reads. A real import reads the most a read
 * answers (256 KiB) and grants in bulk; this one is small so a short file
 * takes several steps.
 */
export const CSV_SLICE_BYTES = 48;

/** `customer_id,ref` rows of one slice of whole lines (a header row and blank lines skipped). */
function csvRows(text: string): Array<{ customerId: string; ref: string | null }> {
  return text.split(/\r?\n/u).flatMap((line) => {
    const [customerId = "", ref = ""] = line.split(",").map((cell) => cell.trim());
    if (customerId === "" || customerId === "customer_id") return [];
    return [{ customerId, ref: ref === "" ? null : ref }];
  });
}

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
      "import-csv": async (request, ctx) => {
        if (request.method === "POST") {
          const { values } = (request.body ?? {}) as { values?: { file?: unknown } };
          const upload = typeof values?.file === "string" ? await ctx.uploads.get(values.file) : null;
          if (!upload) return { status: 422, body: ui.result({ errors: { file: "Choose a CSV file." } }) };
          const job = await ctx.jobs.start("import_csv", { input: { uploadId: upload.id }, key: `csv-${upload.id}` });
          return { body: { job, ...ui.result({ toast: `Importing ${upload.filename}`, refresh: true }) } };
        }
        const [job] = await ctx.jobs.list({ name: "import_csv", limit: 1 });
        return {
          body: ui.page([
            ui.form(ui.route("import-csv"), "Import", [
              ui.fileField("file", "Members CSV", { accept: ["text/csv"], required: true, help: "One customer_id,ref row per member." }),
            ]),
            ...(job ? [ui.progress("Importing members", job.progress.done, Math.max(1, job.progress.total), { live: job.status === "running", ...(job.message ? { help: job.message } : {}) })] : []),
          ], { title: "Import members" }),
        };
      },
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
    import_csv: async (ctx, job) => {
      const { uploadId } = (job.input ?? {}) as { uploadId: string };
      const { offset = 0, imported = 0 } = (job.state ?? {}) as { offset?: number; imported?: number };
      const slice = await ctx.uploads.read(uploadId, { offset, length: CSV_SLICE_BYTES });
      const rows = csvRows(slice.text);
      for (const row of rows) await ctx.customers.roles.grant(row.customerId, "member", { ref: row.ref });
      if (slice.done) await ctx.uploads.delete(uploadId);
      const total = imported + rows.length;
      return {
        state: { offset: slice.nextOffset, imported: total },
        progress: { done: slice.nextOffset, total: slice.sizeBytes },
        message: `${total} members imported`,
        done: slice.done,
      };
    },
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
