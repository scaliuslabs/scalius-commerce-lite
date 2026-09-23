import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getGeneralSettings,
  getHomepagePresentationSettings,
  saveHomepagePresentationSettings,
  saveFooterConfig,
  saveHeaderConfig,
} from "./site-settings.service";

describe("header, footer and homepage revision authority", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
  });

  afterEach(() => sqlite.close());

  it("claims each missing document once and rejects a competing first writer", async () => {
    await expect(saveHeaderConfig(db, { topBar: { text: "", isEnabled: false } }, 0))
      .resolves.toEqual({ revision: 1 });
    await expect(saveHeaderConfig(db, { topBar: { text: "Other tab", isEnabled: true } }, 0))
      .rejects.toMatchObject({
        status: 409,
        code: "SITE_PRESENTATION_REVISION_CONFLICT",
        details: { section: "header", expectedRevision: 0, currentRevision: 1 },
      });
    // The footer is its own document.
    await expect(saveFooterConfig(db, { tagline: "" }, 0)).resolves.toEqual({ revision: 1 });
  });

  it("replaces a document per save, strips navigation, and never accepts a stale write", async () => {
    await saveHeaderConfig(db, { topBar: { text: "First", isEnabled: true }, contact: { phone: "01700" } }, 0);
    await expect(saveHeaderConfig(db, {
      topBar: { text: "Hello", isEnabled: true },
      navigation: [{ id: "legacy" }],
    }, 1)).resolves.toEqual({ revision: 2 });
    await expect(saveHeaderConfig(db, { topBar: { text: "Stale", isEnabled: true } }, 1))
      .rejects.toMatchObject({
        status: 409,
        details: { section: "header", expectedRevision: 1, currentRevision: 2 },
      });

    const general = await getGeneralSettings(db);
    expect(general.headerConfig).toEqual({ topBar: { text: "Hello", isEnabled: true } });
    expect(general.revisions).toEqual({ header: 2, footer: 0 });
    const row = sqlite.prepare("SELECT value FROM settings WHERE category = 'header'").get() as { value: string };
    expect(JSON.parse(row.value)).toEqual({ topBar: { text: "Hello", isEnabled: true } });
  });

  it("rejects a presentation save that points at media being deleted", async () => {
    sqlite.exec(`INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, trashed_at)
      VALUES ('m1', 'logo.png', 'image', 'media/2026/logo.png', 1, 'image/png', 'deleting', unixepoch())`);
    await expect(saveHeaderConfig(db, { logo: { src: "https://cdn.example.com/media/2026/logo.png" } }, 0))
      .rejects.toMatchObject({ status: 409 });
    expect((await getGeneralSettings(db)).revisions.header).toBe(0);
  });

  it("stores one ordered homepage document and rejects stale writes", async () => {
    await saveHomepagePresentationSettings(db, {
      categoryRail: { enabled: false, title: "", categoryIds: [] },
      trustStrip: { enabled: false },
    }, 0);

    await expect(saveHomepagePresentationSettings(db, {
      categoryRail: {
        enabled: true,
        title: "Browse",
        categoryIds: ["cat-b", "cat-a", "cat-b"],
      },
      trustStrip: { enabled: true },
    }, 1)).resolves.toEqual({
      config: {
        categoryRail: {
          enabled: true,
          title: "Browse",
          categoryIds: ["cat-b", "cat-a"],
        },
        trustStrip: { enabled: true },
      },
      revision: 2,
    });

    await expect(saveHomepagePresentationSettings(db, {
      categoryRail: { enabled: false, title: "Stale", categoryIds: [] },
      trustStrip: { enabled: false },
    }, 1)).rejects.toMatchObject({
      status: 409,
      code: "HOMEPAGE_PRESENTATION_REVISION_CONFLICT",
      details: { expectedRevision: 1, currentRevision: 2 },
    });

    await expect(getHomepagePresentationSettings(db)).resolves.toEqual({
      config: {
        categoryRail: {
          enabled: true,
          title: "Browse",
          categoryIds: ["cat-b", "cat-a"],
        },
        trustStrip: { enabled: true },
      },
      revision: 2,
    });
  });
});
