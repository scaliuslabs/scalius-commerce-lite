// Theme writes in the stable app API (operation-registry/README.md), mounted
// at /admin/resources (/theme): what an app (a theme app's onboarding, a demo
// store) changes in the shared theme draft, under the draft revisions it
// read. Nothing here publishes: buyers see a change only when staff publish
// the draft. The Sensitive `write_themes` scope confers `settings.theme.edit`
// only (migration 0170).
//
//   - `theme.get`: the draft's revisions and one page's sections (home, or a
//     landing page), each section's settings as stored. Section settings
//     follow the theme document's own versioned schema, so the app contract
//     carries them as objects, not as sealed fields.
//   - `theme.apply_template`: applies an app's template (its look, skins and
//     homepage) to the draft, as the template library does. An app applies
//     only its own templates. Catalogue handles in the template resolve now
//     (`@scalius/shared/storefront-theme` handles); a section naming a handle
//     the store lacks is left out and reported. The draft it replaces is kept
//     as a restore point.
//   - `theme.set_section_settings`: merges settings into one section of the
//     home or a landing page (an app section: into its values), resolves
//     handles, and saves after the section and the whole document validate.
//
// Every answer carries the theme as `theme.get` reads it (`{ theme }`), the
// writes with their own receipt fields beside it, and every write takes the
// draft's `revision` as `expectedRevision` (plus `basePublishedRevision`, the
// live theme the draft was based on).
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  STOREFRONT_DECLARATION_THEME_VERSION,
  STOREFRONT_THEME_DOCUMENT_VERSION,
  applyStorefrontAppTemplate,
  resolveStorefrontAppTemplateTheme,
  resolveStorefrontHandles,
  storefrontLandingSlugSchema,
  storefrontSectionSchema,
  type StorefrontSection,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { pluginSurfaceKey } from "@scalius/shared/plugins";
import { getThemeWorkspace, replaceThemeDraft, saveThemeDraft } from "@scalius/core/modules/settings";
import { listPluginInstallations } from "@scalius/core/modules/plugins";
import { readThemeHandleLookup } from "@scalius/core/modules/storefront";
import { ConflictError } from "@scalius/core/errors";
import { ok } from "../../utils/api-response";
import { AppError, NotFoundError, ValidationError } from "../../utils/api-error";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";
import { isoTimestampSchema, nullableIsoTimestampSchema } from "../../schemas/timestamps";
import { idempotencyKeyHeaderSchema } from "./idempotency";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});

/** Settings one section-settings write merges (JSON bytes). */
export const THEME_SECTION_SETTINGS_MAX_BYTES = 32_768;

const revision = z.number().int().nonnegative();
const draftPreconditions = {
  expectedRevision: revision.openapi({ description: "The draft `revision` you read (`theme.draft.revision`); 0 when no draft was ever saved. A draft changed since is refused with 409 and nothing is saved." }),
  basePublishedRevision: revision.openapi({ description: "The draft's `basePublishedRevision` you read: the live theme it was based on." }),
};

const draftSchema = z.object({
  revision,
  basePublishedRevision: revision,
  updatedAt: nullableIsoTimestampSchema,
}).openapi("ThemeDraftReceipt");

const sectionSchema = z.object({
  id: z.string(),
  type: z.string().openapi({ description: "The section type (`hero`, `product_grid`…), or `app` for an app's own section." }),
  app: z.string().nullable().openapi({ description: "An app section's `<app id>/<section type>`; null for the platform's." }),
  hidden: z.boolean(),
  settings: z.record(z.string(), z.unknown()).openapi({ description: "The section's settings as the theme document stores them (an app section: its own values)." }),
}).openapi("ThemeSection");

const unresolvedSchema = z.object({
  kind: z.enum(["category", "collection"]),
  handle: z.string(),
  sectionId: z.string().nullable(),
}).openapi("ThemeUnresolvedHandle");

function issuesError(error: z.ZodError, prefix: string): ValidationError {
  const issue = error.issues[0];
  return new ValidationError(`${prefix}${issue?.path.length ? ` (${issue.path.join(".")})` : ""}: ${issue?.message ?? "invalid"}`, {
    issues: error.issues.slice(0, 20).map((each) => ({ path: each.path.join("."), message: each.message })),
  });
}

function presentSection(section: StorefrontSection): z.infer<typeof sectionSchema> {
  const settings = section.settings as Record<string, unknown>;
  const isApp = section.type === "app";
  return {
    id: section.id,
    type: section.type,
    app: isApp ? String(settings.app) : null,
    hidden: section.hidden === true,
    settings: isApp ? ((settings.values as Record<string, unknown> | undefined) ?? {}) : settings,
  };
}

function draftReceipt(draft: { revision: number; basePublishedRevision: number; updatedAt: Date | null }) {
  return { revision: draft.revision, basePublishedRevision: draft.basePublishedRevision, updatedAt: draft.updatedAt ? draft.updatedAt.toISOString() : null };
}

function pagePreconditions(workspace: ThemeWorkspace, body: { expectedRevision: number; basePublishedRevision: number }) {
  if (workspace.draft.revision !== body.expectedRevision || workspace.draft.basePublishedRevision !== body.basePublishedRevision) {
    throw new ConflictError("The theme draft changed since you read it. Read it again (theme.get) and retry.");
  }
}

/** The calling app, when the caller is one. */
function callingApp(c: Context): string | null {
  const principal = c.get("pluginPrincipal" as never) as { pluginId?: string } | undefined;
  return typeof principal?.pluginId === "string" ? principal.pluginId : null;
}

function actorOf(c: Context): string | null {
  const user = c.get("user" as never) as { id?: string } | undefined;
  return user?.id ?? null;
}

type ThemeWorkspace = Awaited<ReturnType<typeof getThemeWorkspace>>;

const themeSchema = z.object({
  documentVersion: z.number().int().positive().openapi({ description: "The theme document version section settings follow." }),
  publishedRevision: revision,
  draft: draftSchema,
  draftDiffersFromLive: z.boolean(),
  template: z.string().nullable().openapi({ description: "The template the draft came from (`<app id>/<template id>`), if any." }),
  page: z.enum(["home", "landing"]),
  slug: z.string().nullable(),
  sections: z.array(sectionSchema).max(24),
  landingPages: z.array(z.object({ slug: z.string(), title: z.string() })).max(20),
  readAt: isoTimestampSchema,
}).openapi("ThemeResource");

/** The draft as `theme.get` reads it, with one page's sections (the homepage, or the landing page `landing`). */
function themeView(workspace: ThemeWorkspace, landing: string | undefined): z.infer<typeof themeSchema> {
  const document = workspace.draft.theme;
  const sections = landing === undefined ? document.pages.home : document.pages.landing[landing]?.sections;
  if (!sections) throw new NotFoundError("That landing page is not in the draft.");
  return {
    documentVersion: STOREFRONT_THEME_DOCUMENT_VERSION,
    publishedRevision: workspace.published.revision,
    draft: draftReceipt(workspace.draft),
    draftDiffersFromLive: workspace.draftDiffersFromLive,
    template: document.apps?.template ?? null,
    page: landing === undefined ? "home" : "landing",
    slug: landing ?? null,
    sections: sections.map(presentSection),
    landingPages: Object.entries(document.pages.landing).map(([slug, page]) => ({ slug, title: page.title })),
    readAt: new Date().toISOString(),
  };
}

// ── theme.get ──

app.openapi(createRoute({
  operationId: "dashboard.resources.theme.get",
  method: "get",
  path: "/theme",
  tags: ["App API - Theme"],
  summary: "Read the theme draft's revisions and one page's sections",
  description: "The shared draft (what staff publish next): its revisions, the template it came from, and the sections of the homepage or of one landing page (`landing=<slug>`), each with its settings as stored.",
  request: {
    query: z.object({
      landing: storefrontLandingSlugSchema.optional().openapi({ description: "A landing page's slug; omit for the homepage." }),
    }),
  },
  responses: {
    200: {
      description: "The theme draft",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({ theme: themeSchema })),
        },
      },
    },
    ...errorResponses,
  },
}), async (c) => {
  const { landing } = c.req.valid("query");
  return ok(c, { theme: themeView(await getThemeWorkspace(c.get("db")), landing) });
});

// ── theme.apply_template ──

const applyBody = z.object({
  template: z.string().trim().min(1).max(160).openapi({
    description: "The template: its id in the calling app's manifest (`storefront.templates[].id`), or `<app id>/<template id>`. An app applies only its own templates.",
  }),
  ...draftPreconditions,
}).strict();

app.openapi(createRoute({
  operationId: "dashboard.resources.theme.apply_template",
  method: "post",
  path: "/theme/apply-template",
  tags: ["App API - Theme"],
  summary: "Apply an app's template to the theme draft",
  description: "Applies the template's look, skins and homepage to the shared draft, as the template library does, and keeps the draft it replaces as a restore point. Catalogue handles in the template (`@category:<handle>`, `@collection:<handle>`, `{ kind, handle }` product sources, `/collections/@<handle>` links) resolve now; a homepage section naming a handle the store lacks is left out and listed in `unresolved`. Never publishes.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: applyBody } } },
  },
  responses: {
    200: {
      description: "The theme with the template applied (its homepage), the template and the handles left out",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            theme: themeSchema,
            template: z.string(),
            unresolved: z.array(unresolvedSchema).max(200),
          })),
        },
      },
    },
    409: conflictResponse,
    ...errorResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const caller = callingApp(c);
  const key = body.template.includes("/") ? body.template : caller ? pluginSurfaceKey(caller, body.template) : null;
  if (!key) throw new ValidationError("Name the template as <app id>/<template id>.", { field: "template" });
  const separator = key.indexOf("/");
  const [pluginId, templateId] = [key.slice(0, separator), key.slice(separator + 1)];
  if (caller && caller !== pluginId) {
    throw new AppError(403, "template_not_owned", "An app applies only its own templates.");
  }
  const installation = (await listPluginInstallations(db)).find((each) => each.pluginId === pluginId);
  // The template library offers an app's templates only while its approved grant covers storefront code.
  const declared = installation?.status === "active" && installation.grant?.storefrontSurfaces === true && installation.grant.storefrontCode === true
    ? installation.manifest.storefront.templates.find((template) => template.id === templateId)
    : undefined;
  if (!declared) throw new NotFoundError("No active app offers that template.");
  const lookup = await readThemeHandleLookup(db, [declared.theme]);
  const read = resolveStorefrontAppTemplateTheme(declared.theme, declared.themeVersion ?? STOREFRONT_DECLARATION_THEME_VERSION, lookup);
  if (!read.ok) throw new AppError(422, "template_unavailable", `This template does not fit the store's theme: ${read.problem}`);
  const workspace = await getThemeWorkspace(db);
  pagePreconditions(workspace, body);
  const applied: StorefrontThemeDocument = applyStorefrontAppTemplate(workspace.draft.theme, key, read.value);
  await replaceThemeDraft(db, applied, workspace.draft.theme, body.expectedRevision, body.basePublishedRevision, actorOf(c));
  return ok(c, {
    theme: themeView(await getThemeWorkspace(db), undefined),
    template: key,
    unresolved: read.unresolved.slice(0, 200),
  });
});

// ── theme.set_section_settings ──

const settingsBody = z.object({
  page: z.enum(["home", "landing"]).default("home"),
  slug: storefrontLandingSlugSchema.optional().openapi({ description: "The landing page's slug, with `page: \"landing\"`." }),
  sectionId: z.string().trim().min(1).max(64),
  settings: z.record(z.string().max(64), z.unknown()).refine(
    (value) => JSON.stringify(value).length <= THEME_SECTION_SETTINGS_MAX_BYTES,
    `At most ${THEME_SECTION_SETTINGS_MAX_BYTES} bytes of settings.`,
  ).openapi({ description: "Settings to merge at the top level (an app section: into its values). Catalogue handles resolve as in apply_template." }),
  ...draftPreconditions,
}).strict();

app.openapi(createRoute({
  operationId: "dashboard.resources.theme.section_settings_set",
  method: "post",
  path: "/theme/section-settings",
  tags: ["App API - Theme"],
  summary: "Merge settings into one section of the theme draft",
  description: "Merges `settings` into the section's settings (an app section: its values), resolves catalogue handles, checks the section against its type's schema and the whole draft as a save does, and saves the draft. Never publishes.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: settingsBody } } },
  },
  responses: {
    200: {
      description: "The theme as it now reads (the section's page) and the section",
      content: { "application/json": { schema: successEnvelope(z.object({ theme: themeSchema, section: sectionSchema })) } },
    },
    409: conflictResponse,
    ...errorResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  if ((body.page === "landing") !== (body.slug !== undefined)) {
    throw new ValidationError("Name a landing page's slug exactly when page is landing.", { field: "slug" });
  }
  const lookup = await readThemeHandleLookup(db, [body.settings]);
  const resolved = resolveStorefrontHandles(body.settings, lookup);
  const missing = resolved.unresolved[0];
  if (missing) {
    throw new AppError(422, "handle_unresolved", `No ${missing.kind} has the handle ${missing.handle}.`, { unresolved: resolved.unresolved.slice(0, 20) });
  }
  const patch = resolved.value as Record<string, unknown>;
  const workspace = await getThemeWorkspace(db);
  pagePreconditions(workspace, body);
  const theme = structuredClone(workspace.draft.theme);
  const sections = body.page === "home" ? theme.pages.home : theme.pages.landing[body.slug!]?.sections;
  if (!sections) throw new NotFoundError("That landing page is not in the draft.");
  const index = sections.findIndex((section) => section.id === body.sectionId);
  if (index < 0) throw new AppError(404, "section_not_found", "No section with that id is on the page.");
  const current = sections[index]!;
  const stored = current.settings as Record<string, unknown>;
  const settings = current.type === "app"
    ? { ...stored, values: { ...((stored.values as Record<string, unknown> | undefined) ?? {}), ...patch } }
    : { ...stored, ...patch };
  const parsed = storefrontSectionSchema.safeParse({ ...current, settings });
  if (!parsed.success) throw issuesError(parsed.error, "These settings do not fit the section");
  sections[index] = parsed.data;
  await saveThemeDraft(db, theme, body.expectedRevision, body.basePublishedRevision, actorOf(c));
  return ok(c, {
    theme: themeView(await getThemeWorkspace(db), body.page === "landing" ? body.slug : undefined),
    section: presentSection(parsed.data),
  });
});

export { app as adminResourceThemeRoutes };
