import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  STOREFRONT_MAX_SECTIONS,
  storefrontSectionDefault,
  storefrontTemplateTheme,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";

import {
  THEME_DRAFT_SECTIONS_MAX,
  THEME_RESTORE_POINT_LIMIT,
  acceptDraftedSections,
  discardThemeDraft,
  draftThemeSections,
  getThemeRestorePoint,
  getThemeWorkspace,
  listThemeRestorePoints,
  publishThemeDraft,
  restoreThemeRestorePoint,
  restoreThemeVersion,
  saveThemeDraft,
  themeWithDraftedSections,
} from "./site-settings.service";

interface PointRow { id: string; reason: string; draft_revision: number; created_by: string | null; theme: string }

describe("theme restore points", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
  });

  afterEach(() => sqlite.close());

  function seedPublishedWorkspace(theme: StorefrontThemeDocument = DEFAULT_STOREFRONT_THEME) {
    const serialized = JSON.stringify(theme);
    sqlite.prepare("INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, 1, 1, 1)").run(serialized);
    sqlite.prepare(`
      INSERT INTO theme_settings_drafts (id, theme, revision, base_published_revision, updated_by, created_at, updated_at)
      VALUES ('default', ?, 1, 1, NULL, 1, 1)
    `).run(serialized);
    sqlite.prepare(`
      INSERT INTO theme_settings_versions (id, published_revision, theme, source, source_revision, published_by, created_at)
      VALUES ('themev_seed_1', 1, ?, 'migration', NULL, NULL, 1)
    `).run(serialized);
  }

  const points = () => sqlite.prepare("SELECT id, reason, draft_revision, created_by, theme FROM theme_restore_points ORDER BY created_at, id").all() as unknown as PointRow[];
  const draftTheme = async () => (await getThemeWorkspace(db)).draft.theme;

  it("keeps the draft a discard replaces", async () => {
    seedPublishedWorkspace();
    const edited = storefrontTemplateTheme("boutique");
    await saveThemeDraft(db, edited, 1, 1, "staff_1");
    expect(points()).toEqual([]);

    await discardThemeDraft(db, 2, 1, "staff_2");
    const [point, ...others] = points();
    expect(others).toEqual([]);
    expect(point).toMatchObject({ reason: "discard", draft_revision: 2, created_by: "staff_2" });
    expect(JSON.parse(point!.theme)).toEqual(edited);
    expect(await draftTheme()).toEqual(DEFAULT_STOREFRONT_THEME);
  });

  it("keeps the draft a version restore replaces, and plain saves keep nothing", async () => {
    seedPublishedWorkspace();
    const edited = storefrontTemplateTheme("boutique");
    await saveThemeDraft(db, edited, 1, 1, "staff_1");
    await saveThemeDraft(db, edited, 2, 1, "staff_1");
    expect(points()).toEqual([]);

    await restoreThemeVersion(db, 1, 3, 1, "staff_2");
    const [point, ...others] = points();
    expect(others).toEqual([]);
    expect(point).toMatchObject({ reason: "restore", draft_revision: 3, created_by: "staff_2" });
    expect(JSON.parse(point!.theme)).toEqual(edited);
  });

  it("keeps nothing when no draft was ever saved", async () => {
    seedPublishedWorkspace();
    sqlite.exec("DELETE FROM theme_settings_drafts");
    await discardThemeDraft(db, 0, 1);
    expect(points()).toEqual([]);
  });

  it("keeps the newest ten and prunes the oldest in the same batch", async () => {
    seedPublishedWorkspace();
    const insert = sqlite.prepare(`
      INSERT INTO theme_restore_points (id, theme, draft_revision, reason, created_by, created_at)
      VALUES (?, ?, 1, 'discard', NULL, ?)
    `);
    for (let at = 1; at <= THEME_RESTORE_POINT_LIMIT; at += 1) insert.run(`themerp_old${String(at).padStart(2, "0")}`, "{}", at);
    expect(points()).toHaveLength(THEME_RESTORE_POINT_LIMIT);

    await saveThemeDraft(db, storefrontTemplateTheme("boutique"), 1, 1);
    await discardThemeDraft(db, 2, 1, "staff_1");
    const kept = points();
    expect(kept).toHaveLength(THEME_RESTORE_POINT_LIMIT);
    expect(kept.map((row) => row.id)).not.toContain("themerp_old01");
    expect(kept.map((row) => row.id)).toContain("themerp_old02");
    expect(kept.at(-1)).toMatchObject({ created_by: "staff_1" });
    expect((await listThemeRestorePoints(db)).map((row) => row.id)).toEqual(kept.map((row) => row.id).reverse());
  });

  it("lists newest first without documents and reads one with its document", async () => {
    seedPublishedWorkspace();
    const edited = storefrontTemplateTheme("boutique");
    await saveThemeDraft(db, edited, 1, 1, "staff_1");
    await discardThemeDraft(db, 2, 1, "staff_1");
    const [summary] = await listThemeRestorePoints(db);
    expect(summary).toMatchObject({ reason: "discard", draftRevision: 2, createdBy: "staff_1", createdByName: null });
    expect(summary).not.toHaveProperty("theme");
    await expect(getThemeRestorePoint(db, summary!.id)).resolves.toMatchObject({ theme: edited, reason: "discard" });
    await expect(getThemeRestorePoint(db, "themerp_missing1")).rejects.toMatchObject({ status: 404 });
    await expect(getThemeRestorePoint(db, "not-a-point")).rejects.toMatchObject({ status: 400 });
  });

  it("puts a restore point back in the draft, never live, and keeps the draft it replaced so the restore can be undone", async () => {
    seedPublishedWorkspace();
    const first = storefrontTemplateTheme("boutique");
    await saveThemeDraft(db, first, 1, 1, "staff_1");
    await discardThemeDraft(db, 2, 1, "staff_1");
    // Points are ordered by the second they were made: put the first one earlier.
    sqlite.exec("UPDATE theme_restore_points SET created_at = created_at - 100");
    const [discarded] = await listThemeRestorePoints(db);

    const second = storefrontTemplateTheme("marketplace");
    await saveThemeDraft(db, second, 3, 1, "staff_1");
    const status = await restoreThemeRestorePoint(db, discarded!.id, 4, 1, "staff_2");
    expect(status).toMatchObject({ published: { revision: 1 }, draft: { revision: 5, basePublishedRevision: 1 }, draftDiffersFromLive: true });
    expect(await draftTheme()).toEqual(first);
    // Live did not move.
    const live = sqlite.prepare("SELECT revision FROM theme_settings WHERE id = 'default'").get();
    expect(live).toEqual({ revision: 1 });

    // The draft the restore replaced is a point of its own, and restoring it undoes the restore.
    const [newest] = await listThemeRestorePoints(db);
    expect(newest).toMatchObject({ reason: "restore", draftRevision: 4, createdBy: "staff_2" });
    expect(newest!.id).not.toBe(discarded!.id);
    await restoreThemeRestorePoint(db, newest!.id, 5, 1, "staff_2");
    expect(await draftTheme()).toEqual(second);
    expect(await listThemeRestorePoints(db)).toHaveLength(3);
  });

  it("refuses a restore on a stale draft revision or a moved live revision and writes nothing", async () => {
    seedPublishedWorkspace();
    await saveThemeDraft(db, storefrontTemplateTheme("boutique"), 1, 1);
    await discardThemeDraft(db, 2, 1);
    const [point] = await listThemeRestorePoints(db);
    const before = points();

    await expect(restoreThemeRestorePoint(db, point!.id, 2, 1)).rejects.toMatchObject({ status: 409, code: "conflict" });
    await expect(restoreThemeRestorePoint(db, point!.id, 3, 2)).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(points()).toEqual(before);
    expect((await getThemeWorkspace(db)).draft.revision).toBe(3);

    // A publish moves live: the point taken before it cannot be restored on the old base.
    await publishThemeDraft(db, 1, 3);
    await expect(restoreThemeRestorePoint(db, point!.id, 4, 1)).rejects.toMatchObject({ status: 409 });
    await expect(restoreThemeRestorePoint(db, point!.id, 4, 2)).resolves.toMatchObject({ draft: { revision: 5 } });
  });

  it("refuses a restore of a point naming images deleted since, unless asked to leave them out", async () => {
    seedPublishedWorkspace();
    const withImage = structuredClone(DEFAULT_STOREFRONT_THEME) as StorefrontThemeDocument;
    withImage.brand.logo = "media_gone";
    sqlite.exec(`INSERT INTO media (id, filename, kind, object_key, size, mime_type, status) VALUES ('media_gone', 'a.png', 'image', 'media/a.png', 1, 'image/png', 'ready')`);
    await saveThemeDraft(db, withImage, 1, 1);
    await discardThemeDraft(db, 2, 1);
    const [point] = await listThemeRestorePoints(db);
    sqlite.exec("UPDATE media SET status = 'deleted', trashed_at = unixepoch(), deleted_at = unixepoch() WHERE id = 'media_gone'");
    await expect(restoreThemeRestorePoint(db, point!.id, 3, 1)).rejects.toMatchObject({
      status: 400, code: "theme_version_images_missing", details: { missingImages: 1 },
    });
    await expect(restoreThemeRestorePoint(db, point!.id, 3, 1, null, { withoutMissingImages: true })).resolves.toMatchObject({ draft: { revision: 4 } });
    expect((await getThemeWorkspace(db)).draft.theme.brand.logo).toBeNull();
  });
});

describe("drafted sections", () => {
  const faq = (extra: Record<string, unknown> = {}) => ({
    type: "faq",
    settings: { heading: "Questions", items: [{ question: "Shipping?", answer: "Two days." }] },
    ...extra,
  });

  it("keeps valid sections with fresh ids and aiDraft, and counts the rest as rejected", () => {
    const result = acceptDraftedSections(
      [
        faq({ id: "model-chose-this", version: 1 }),
        faq(),
        { type: "faq", settings: { heading: "", items: [{ question: "", answer: "" }] } },
        { type: "no-such-section", settings: {} },
        { id: "x", type: "app", version: 1, settings: { app: "acme.shop/widget", values: {} } },
        "not an object",
        null,
        [],
      ],
      [{ id: "faq" }],
    );
    expect(result.sections.map((section) => [section.id, section.type, section.aiDraft])).toEqual([
      ["faq-2", "faq", true],
      ["faq-3", "faq", true],
    ]);
    expect(result.rejected).toBe(6);
  });

  it("never lets a candidate choose aiDraft or keep an app section", () => {
    const result = acceptDraftedSections([faq({ aiDraft: false }), faq({ aiDraft: true })], []);
    expect(result.sections.map((section) => section.aiDraft)).toEqual([true, true]);
    const app = acceptDraftedSections([{ type: "app", version: 1, settings: { app: "acme.shop/widget", values: {} } }], []);
    expect(app).toEqual({ sections: [], rejected: 1 });
  });

  it("takes at most the per-call limit and counts the rest as rejected", () => {
    const many = Array.from({ length: THEME_DRAFT_SECTIONS_MAX + 3 }, () => faq());
    const result = acceptDraftedSections(many, []);
    expect(result.sections).toHaveLength(THEME_DRAFT_SECTIONS_MAX);
    expect(result.rejected).toBe(3);
    expect(new Set(result.sections.map((section) => section.id)).size).toBe(THEME_DRAFT_SECTIONS_MAX);
  });

  it("inserts into a template before or after its fixed part, moving the fixed part with sections before it", () => {
    const [added] = acceptDraftedSections([faq()], []).sections;
    const base = structuredClone(DEFAULT_STOREFRONT_THEME) as StorefrontThemeDocument;
    base.pages.templates.product = { sections: [storefrontSectionDefault("faq", "above"), storefrontSectionDefault("faq", "below")], main: 1 };
    const before = themeWithDraftedSections(base, { kind: "template", template: "product", region: "before" }, [added!]);
    expect(before.pages.templates.product.sections.map((section) => section.id)).toEqual(["above", "faq", "below"]);
    expect(before.pages.templates.product.main).toBe(2);
    const after = themeWithDraftedSections(base, { kind: "template", template: "product", region: "after" }, [added!]);
    expect(after.pages.templates.product.sections.map((section) => section.id)).toEqual(["above", "below", "faq"]);
    expect(after.pages.templates.product.main).toBe(1);
  });
});

describe("drafting sections into the shared draft", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    const serialized = JSON.stringify(DEFAULT_STOREFRONT_THEME);
    sqlite.prepare("INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, 1, 1, 1)").run(serialized);
    sqlite.prepare(`
      INSERT INTO theme_settings_drafts (id, theme, revision, base_published_revision, updated_by, created_at, updated_at)
      VALUES ('default', ?, 1, 1, NULL, 1, 1)
    `).run(serialized);
  });

  afterEach(() => sqlite.close());

  const faq = { type: "faq", settings: { heading: "Questions", items: [{ question: "Shipping?", answer: "Two days." }] } };

  it("adds to the homepage, a landing page and a template, each marked as an AI draft, and leaves live alone", async () => {
    const home = await draftThemeSections(db, { scope: { kind: "home" }, sections: [faq] }, 1, 1, "agent_1");
    expect(home).toMatchObject({ revision: 2, rejected: 0 });
    expect(home.theme.pages.home.at(-1)).toMatchObject({ type: "faq", aiDraft: true });
    expect(home.added).toEqual([home.theme.pages.home.at(-1)!.id]);

    const workspace = await getThemeWorkspace(db);
    const landing = structuredClone(workspace.draft.theme.pages.home).slice(0, 1);
    sqlite.prepare("UPDATE theme_settings_drafts SET theme = ? WHERE id = 'default'")
      .run(JSON.stringify({ ...workspace.draft.theme, pages: { ...workspace.draft.theme.pages, landing: { eid: { title: "Eid", description: "", sections: landing } } } }));
    const onLanding = await draftThemeSections(db, { scope: { kind: "landing", slug: "eid" }, sections: [faq] }, 2, 1, "agent_1");
    expect(onLanding.theme.pages.landing.eid!.sections).toHaveLength(2);
    expect(onLanding.theme.pages.landing.eid!.sections.at(-1)).toMatchObject({ type: "faq", aiDraft: true });
    expect(onLanding.theme.pages.home).toEqual(home.theme.pages.home);

    const onTemplate = await draftThemeSections(db, { scope: { kind: "template", template: "cart", region: "before" }, sections: [faq] }, 3, 1, "agent_1");
    expect(onTemplate.theme.pages.templates.cart).toMatchObject({ main: 1, sections: [{ type: "faq", aiDraft: true }] });
    expect(onTemplate.theme.pages.templates.product).toEqual(DEFAULT_STOREFRONT_THEME.pages.templates.product);

    const live = sqlite.prepare("SELECT colors, revision FROM theme_settings WHERE id = 'default'").get() as { colors: string; revision: number };
    expect(live.revision).toBe(1);
    expect(JSON.parse(live.colors)).toEqual(DEFAULT_STOREFRONT_THEME);
  });

  it("places sections after the section it names", async () => {
    const first = (await getThemeWorkspace(db)).draft.theme.pages.home[0]!;
    const saved = await draftThemeSections(db, { scope: { kind: "home" }, sections: [faq], afterId: first.id }, 1, 1);
    expect(saved.theme.pages.home[1]).toMatchObject({ type: "faq", aiDraft: true });
    expect(saved.theme.pages.home[0]!.id).toBe(first.id);
  });

  it("refuses a call with no valid section, an unknown landing page and a stale revision, and writes nothing", async () => {
    await expect(draftThemeSections(db, { scope: { kind: "home" }, sections: [{ type: "nope" }] }, 1, 1))
      .rejects.toMatchObject({ status: 400 });
    await expect(draftThemeSections(db, { scope: { kind: "landing", slug: "missing" }, sections: [faq] }, 1, 1))
      .rejects.toMatchObject({ status: 404 });
    await expect(draftThemeSections(db, { scope: { kind: "home" }, sections: [faq] }, 5, 1))
      .rejects.toMatchObject({ status: 409 });
    await expect(draftThemeSections(db, { scope: { kind: "home" }, sections: [faq] }, 1, 2))
      .rejects.toMatchObject({ status: 409 });
    expect((await getThemeWorkspace(db)).draft).toMatchObject({ revision: 1, theme: DEFAULT_STOREFRONT_THEME });
  });

  it("refuses to take a page past the section limit", async () => {
    const full = structuredClone(DEFAULT_STOREFRONT_THEME) as StorefrontThemeDocument;
    full.pages.home = Array.from({ length: STOREFRONT_MAX_SECTIONS }, (_, index) => storefrontSectionDefault("faq", `faq-${index}`));
    sqlite.prepare("UPDATE theme_settings_drafts SET theme = ? WHERE id = 'default'").run(JSON.stringify(full));
    await expect(draftThemeSections(db, { scope: { kind: "home" }, sections: [faq] }, 1, 1)).rejects.toMatchObject({ status: 400 });
    expect((await getThemeWorkspace(db)).draft.theme.pages.home).toHaveLength(STOREFRONT_MAX_SECTIONS);
  });
});
