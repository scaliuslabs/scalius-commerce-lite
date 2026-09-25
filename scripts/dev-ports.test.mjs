import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LOCAL_DEVELOPMENT_PLATFORM_CONFIG } from "../packages/shared/src/platform-config.ts";
import {
  DEFAULT_API_WORKER_NAME,
  DEFAULT_DEV_PORTS,
  devApiWorkerName,
  devOrigins,
  localStorefrontWorkerConfig,
  platformSyncSql,
  readDevPorts,
  storefrontBindingProblems,
  verifyStorefrontBinding,
} from "./dev-ports.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("local dev ports", () => {
  it("defaults to 8787, 4322 and 4323, the code's local platform defaults", () => {
    expect(readDevPorts({})).toEqual({ api: 8787, storefront: 4322, admin: 4323 });
    const origins = devOrigins(DEFAULT_DEV_PORTS);
    expect(origins).toEqual({
      apiUrl: LOCAL_DEVELOPMENT_PLATFORM_CONFIG.apiUrl,
      storefrontUrl: LOCAL_DEVELOPMENT_PLATFORM_CONFIG.storefrontUrl,
      dashboardUrl: LOCAL_DEVELOPMENT_PLATFORM_CONFIG.dashboardUrl,
      mediaUrl: LOCAL_DEVELOPMENT_PLATFORM_CONFIG.mediaUrl,
    });
  });

  it("reads each port from its SCALIUS_DEV_*_PORT variable", () => {
    const ports = readDevPorts({
      SCALIUS_DEV_API_PORT: "8931",
      SCALIUS_DEV_STOREFRONT_PORT: " 4531 ",
      SCALIUS_DEV_ADMIN_PORT: "4532",
    });
    expect(ports).toEqual({ api: 8931, storefront: 4531, admin: 4532 });
    expect(devOrigins(ports)).toEqual({
      apiUrl: "http://localhost:8931",
      storefrontUrl: "http://localhost:4531",
      dashboardUrl: "http://localhost:4532",
      mediaUrl: "http://localhost:8931/api/v1/media",
    });
    expect(readDevPorts({ SCALIUS_DEV_API_PORT: "" }).api).toBe(8787);
  });

  it.each([["0"], ["65536"], ["87a7"], ["-1"], ["8787.5"]])("rejects the port %j", (value) => {
    expect(() => readDevPorts({ SCALIUS_DEV_API_PORT: value })).toThrow(/SCALIUS_DEV_API_PORT must be a TCP port/);
  });

  it("rejects two apps on one port", () => {
    expect(() => readDevPorts({ SCALIUS_DEV_STOREFRONT_PORT: "8787" })).toThrow(/must differ/);
  });

  it("is what the app dev scripts listen on, never a Worker var", () => {
    const apiPackage = JSON.parse(readFileSync(resolve(root, "apps/api/package.json"), "utf8"));
    expect(apiPackage.scripts.dev).toContain("--port ${SCALIUS_DEV_API_PORT:-8787}");
    expect(apiPackage.scripts.dev).toContain("--name $(node ../../scripts/dev-ports.mjs api-worker-name)");
    const storefrontPackage = JSON.parse(readFileSync(resolve(root, "apps/storefront/package.json"), "utf8"));
    expect(storefrontPackage.scripts.dev).not.toMatch(/--port/);
    expect(readFileSync(resolve(root, "apps/storefront/astro.config.mjs"), "utf8"))
      .toMatch(/server: \{ port: devPorts\.storefront \}/);
    expect(readFileSync(resolve(root, "apps/admin-v2/vite.config.ts"), "utf8"))
      .toMatch(/port: devPorts\.admin/);
    for (const config of ["apps/api/wrangler.jsonc", "apps/api/wrangler.local.jsonc", "apps/storefront/wrangler.jsonc"]) {
      expect(readFileSync(resolve(root, config), "utf8"), config).not.toContain("SCALIUS_DEV_");
    }
  });
});

describe("local Platform settings sync", () => {
  const origins = devOrigins({ api: 8931, storefront: 4531, admin: 4532 });

  function database(value) {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE settings (
      id TEXT PRIMARY KEY, key TEXT NOT NULL, value TEXT NOT NULL, type TEXT NOT NULL,
      category TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER,
      UNIQUE (key, category)
    )`);
    if (value !== undefined) {
      db.prepare("INSERT INTO settings (id, key, value, type, category, revision) VALUES ('p', 'document', ?, 'json', 'platform', 5)")
        .run(JSON.stringify(value));
    }
    return db;
  }
  const sync = (db) => db.prepare(platformSyncSql(origins)).all();
  const read = (db) => {
    const row = db.prepare("SELECT value, revision FROM settings WHERE key = 'document' AND category = 'platform'").get();
    return { document: JSON.parse(row.value), revision: row.revision };
  };

  it("creates the document on a fresh database", () => {
    const db = database();
    expect(sync(db)).toHaveLength(1);
    expect(read(db)).toEqual({ document: origins, revision: 1 });
  });

  it("replaces loopback and unset origins and keeps the rest of the document", () => {
    const db = database({
      storefrontUrl: "http://localhost:4322",
      apiUrl: "http://127.0.0.1:8787",
      dashboardUrl: "",
      customerAuthCookieDomain: "",
      corsAllowedOrigins: ["http://localhost:5173"],
      identityHandoff: { enabled: false },
    });

    expect(sync(db)).toHaveLength(1);
    expect(read(db)).toEqual({
      document: {
        ...origins,
        customerAuthCookieDomain: "",
        corsAllowedOrigins: ["http://localhost:5173"],
        identityHandoff: { enabled: false },
      },
      revision: 6,
    });
  });

  it("keeps an origin the developer saved as a real URL", () => {
    const db = database({
      storefrontUrl: "https://shop.tunnel.example",
      apiUrl: "http://localhost:8787",
      dashboardUrl: "http://[::1]:4323",
      mediaUrl: "https://cdn.example.com/media",
    });

    sync(db);
    expect(read(db).document).toEqual({
      storefrontUrl: "https://shop.tunnel.example",
      apiUrl: origins.apiUrl,
      dashboardUrl: origins.dashboardUrl,
      mediaUrl: "https://cdn.example.com/media",
    });
  });

  it("changes nothing, not even the revision, when the document already matches", () => {
    const db = database(origins);
    expect(sync(db)).toHaveLength(0);
    expect(read(db).revision).toBe(5);
  });
});

describe("local API worker name and the storefront binding", () => {
  it("keeps scalius-api-local on the default port and derives a distinct name elsewhere", () => {
    expect(devApiWorkerName(DEFAULT_DEV_PORTS)).toBe(DEFAULT_API_WORKER_NAME);
    expect(DEFAULT_API_WORKER_NAME).toBe("scalius-api-local");
    expect(devApiWorkerName({ api: 8931, storefront: 4531, admin: 4532 })).toBe("scalius-api-local-8931");
    expect(devApiWorkerName(readDevPorts({ SCALIUS_DEV_API_PORT: "9001" }))).toBe("scalius-api-local-9001");
    // the name the committed local config declares is the default stack's
    expect(readFileSync(resolve(root, "apps/api/wrangler.local.jsonc"), "utf8")).toMatch(/"name": "scalius-api-local"/);
  });

  it("rebinds a built storefront to this stack's API, port and no production route", () => {
    const built = {
      name: "scalius-storefront",
      routes: [{ pattern: "storefront.scalius.com", custom_domain: true }],
      services: [{ binding: "BACKEND_API", service: "scalius-api" }, { binding: "OTHER", service: "x" }],
      dev: { inspector_port: 9231, enable_containers: true },
    };
    const local = localStorefrontWorkerConfig(built, { apiWorkerName: "scalius-api-local-8931", port: 4531, inspectorPort: 24531 });
    expect(local.routes).toBeUndefined();
    expect(local.services).toEqual([{ binding: "BACKEND_API", service: "scalius-api-local-8931" }, { binding: "OTHER", service: "x" }]);
    expect(local.dev).toEqual({ inspector_port: 24531, port: 4531, enable_containers: false });
    expect(built.services[0].service).toBe("scalius-api");
    expect(() => localStorefrontWorkerConfig(built, {})).toThrow(/apiWorkerName/);
    expect(() => localStorefrontWorkerConfig({ services: [] }, { apiWorkerName: "a" })).toThrow(/BACKEND_API/);
  });

  const page = (canonical, img = "") => `<html><head><link rel="canonical" href="${canonical}"><meta property="og:url" content="${canonical}"></head><body>${img}</body></html>`;

  it("identifies the API that rendered the page from its canonical origin and media origin", () => {
    const expected = { storefrontUrl: "http://localhost:4531", mediaUrl: "http://localhost:8931/api/v1/media" };
    expect(storefrontBindingProblems(page("http://localhost:4531/", '<img src="http://localhost:8931/api/v1/media/media/a.jpg/320.webp">'), expected)).toEqual([]);
    expect(storefrontBindingProblems(page("http://localhost:4322/"), expected)[0]).toMatch(/canonical origin is http:\/\/localhost:4322, not http:\/\/localhost:4531: the storefront reached another stack's API/);
    expect(storefrontBindingProblems(page("http://localhost:4531/", '<img srcset="http://localhost:8787/api/v1/media/media/a.jpg/320.webp 320w">'), expected)[0]).toMatch(/media URLs come from http:\/\/localhost:8787/);
    expect(storefrontBindingProblems("<html></html>", expected)[0]).toMatch(/no canonical URL/);
    // a real CDN is not a local stack, so it never counts as foreign
    expect(storefrontBindingProblems(page("http://localhost:4531/", '<img src="https://cdn.example.com/media/a.jpg">'), expected)).toEqual([]);
  });

  it("fails fast when the storefront answers with another stack's origins", async () => {
    const answer = (html, status = 200) => async () => new Response(html, { status });
    await expect(verifyStorefrontBinding({ storefrontUrl: "http://localhost:4531/", fetchImpl: answer(page("http://localhost:4531/")) })).resolves.toBe(true);
    await expect(verifyStorefrontBinding({ storefrontUrl: "http://localhost:4531", fetchImpl: answer(page("http://localhost:4322/")) })).rejects.toThrow(/binding check failed for http:\/\/localhost:4531/);
    await expect(verifyStorefrontBinding({ storefrontUrl: "http://localhost:4531", fetchImpl: answer("oops", 503) })).rejects.toThrow(/answered 503/);
  });
});
