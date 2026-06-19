import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

import { heroRoutes } from "./hero";

const desktopSlider = {
  id: "slider_desktop",
  type: "desktop",
  images: JSON.stringify([
    { url: "https://cdn.example.com/desktop.jpg", alt: null, sortOrder: 1 },
  ]),
  isActive: true,
  createdAt: new Date("2026-06-18T00:00:00.000Z"),
  updatedAt: new Date("2026-06-18T00:00:00.000Z"),
  deletedAt: null,
};

const mobileSlider = {
  id: "slider_mobile",
  type: "mobile",
  images: JSON.stringify([
    { url: "https://cdn.example.com/mobile.jpg", alt: null, sortOrder: 1 },
  ]),
  isActive: true,
  createdAt: new Date("2026-06-18T00:00:00.000Z"),
  updatedAt: new Date("2026-06-18T00:00:00.000Z"),
  deletedAt: null,
};

function createThenableRows(rows: typeof desktopSlider[]) {
  return Object.assign(Promise.resolve(rows), {
    get: async () => rows[0] ?? null,
  });
}

function createDb(rows = [desktopSlider, mobileSlider]) {
  return {
    select: () => ({
      from: () => ({
        where: () => createThenableRows(rows),
      }),
    }),
  };
}

function createKvMock() {
  const store = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({
      keys: [...store.keys()]
        .filter((key) => !prefix || key.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
    })),
  };

  return { kv, store };
}

function createTestApp(rows = [desktopSlider, mobileSlider]) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.use("*", async (c, next) => {
    c.set("db", createDb(rows) as never);
    await next();
  });
  app.route("/hero", heroRoutes);
  return app;
}

async function readHeroImages(response: Response): Promise<string[]> {
  const body = (await response.json()) as {
    success: boolean;
    data?: { images?: Array<{ url: string }> };
  };
  expect(body.success).toBe(true);
  return body.data?.images?.map((image) => image.url) ?? [];
}

describe("hero route cache policy", () => {
  it("varies cached hero slider list responses by explicit type query", async () => {
    const app = createTestApp();
    const { kv } = createKvMock();
    const env = { CACHE: kv } as unknown as Env;

    const desktopResponse = await app.request(
      "/api/v1/hero/sliders?type=desktop",
      {},
      env,
    );
    const mobileResponse = await app.request(
      "/api/v1/hero/sliders?type=mobile",
      {},
      env,
    );

    expect(desktopResponse.headers.get("X-Cache")).toBe("MISS");
    expect(mobileResponse.headers.get("X-Cache")).toBe("MISS");
    expect(await readHeroImages(desktopResponse)).toEqual([
      "https://cdn.example.com/desktop.jpg",
    ]);
    expect(await readHeroImages(mobileResponse)).toEqual([
      "https://cdn.example.com/mobile.jpg",
    ]);
    expect(kv.put).toHaveBeenCalledWith(
      expect.stringMatching(/^sc:api:hero:\/api\/v1\/hero\/sliders\?type=desktop#f:[a-f0-9]+$/),
      expect.any(String),
      { expirationTtl: 3600 },
    );
    expect(kv.put).toHaveBeenCalledWith(
      expect.stringMatching(/^sc:api:hero:\/api\/v1\/hero\/sliders\?type=mobile#f:[a-f0-9]+$/),
      expect.any(String),
      { expirationTtl: 3600 },
    );
  });

  it("does not cache User-Agent auto-detected hero slider list responses", async () => {
    const app = createTestApp();
    const { kv } = createKvMock();
    const env = { CACHE: kv } as unknown as Env;

    const mobileResponse = await app.request(
      "/api/v1/hero/sliders",
      { headers: { "User-Agent": "Mozilla Mobile" } },
      env,
    );
    const desktopResponse = await app.request(
      "/api/v1/hero/sliders",
      { headers: { "User-Agent": "Mozilla Desktop" } },
      env,
    );

    expect(mobileResponse.headers.get("X-Cache")).toBeNull();
    expect(desktopResponse.headers.get("X-Cache")).toBeNull();
    expect(await readHeroImages(mobileResponse)).toEqual([
      "https://cdn.example.com/mobile.jpg",
    ]);
    expect(await readHeroImages(desktopResponse)).toEqual([
      "https://cdn.example.com/desktop.jpg",
    ]);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("returns hero sliders when legacy timestamps are invalid", async () => {
    const app = createTestApp([
      {
        ...desktopSlider,
        createdAt: new Date(Number.NaN),
        updatedAt: new Date(Number.NaN),
      },
      mobileSlider,
    ]);
    const { kv } = createKvMock();
    const env = { CACHE: kv } as unknown as Env;

    const response = await app.request(
      "/api/v1/hero/sliders?type=desktop",
      {},
      env,
    );
    const body = (await response.json()) as {
      success: boolean;
      data?: {
        slider?: {
          createdAt: string | null;
          updatedAt: string | null;
        } | null;
      };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.slider?.createdAt).toBeNull();
    expect(body.data?.slider?.updatedAt).toBeNull();
  });
});
