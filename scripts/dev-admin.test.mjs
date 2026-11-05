import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";

vi.mock("./dev-ports.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    syncLocalPlatform: vi.fn(async () => ({
      origins: { storefrontUrl: "http://localhost:4322", dashboardUrl: "http://localhost:4323" },
    })),
  };
});

let devAdmin;
let originalFetch;

beforeAll(async () => {
  // Importing without setting process.argv[1] to the script path keeps the
  // main guard from firing, so no API requests, workers, or admin creation
  // happen as a side effect of import.
  devAdmin = await import("./dev-admin.mjs");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
});

describe("buildDefaults", () => {
  it("defaults country to EG with no env", () => {
    const d = devAdmin.buildDefaults({});
    expect(d.country).toBe("EG");
  });

  it("respects LOCAL_STORE_COUNTRY env override to BD", () => {
    const d = devAdmin.buildDefaults({ LOCAL_STORE_COUNTRY: "BD" });
    expect(d.country).toBe("BD");
  });

  it("falls back to EG when LOCAL_STORE_COUNTRY is empty", () => {
    const d = devAdmin.buildDefaults({ LOCAL_STORE_COUNTRY: "" });
    expect(d.country).toBe("EG");
  });
});

describe("buildConfig", () => {
  const baseDefaults = {
    apiBaseUrl: "http://localhost:8787",
    email: "admin@local.scalius.test",
    password: "ScaliusLocal123!",
    name: "Local Admin",
    country: "EG",
    storeName: "Scalius Local",
    wranglerState: "/tmp/wrangler/state",
  };

  it("CLI country overrides built-in EG default", () => {
    const c = devAdmin.buildConfig({ country: "US" }, baseDefaults);
    expect(c.country).toBe("US");
  });

  it("CLI country overrides env-provided BD default", () => {
    const d = { ...baseDefaults, country: "BD" };
    const c = devAdmin.buildConfig({ country: "US" }, d);
    expect(c.country).toBe("US");
  });

  it("explicit CLI BD keeps BD", () => {
    const c = devAdmin.buildConfig({ country: "BD" }, baseDefaults);
    expect(c.country).toBe("BD");
  });

  it("CLI country is uppercased and trimmed", () => {
    const c = devAdmin.buildConfig({ country: "  eg  " }, baseDefaults);
    expect(c.country).toBe("EG");
  });

  it("time-zone option sets config.timeZone", () => {
    const c = devAdmin.buildConfig({ "time-zone": "America/New_York" }, baseDefaults);
    expect(c.timeZone).toBe("America/New_York");
  });

  it("no time-zone option yields null", () => {
    const c = devAdmin.buildConfig({}, baseDefaults);
    expect(c.timeZone).toBeNull();
  });
});

describe("resolveStoreTimeZone", () => {
  it("EG defaults to Africa/Cairo", () => {
    expect(devAdmin.resolveStoreTimeZone(undefined, "EG")).toBe("Africa/Cairo");
  });

  it("BD defaults to Asia/Dhaka", () => {
    expect(devAdmin.resolveStoreTimeZone(undefined, "BD")).toBe("Asia/Dhaka");
  });

  it("explicit timeZone wins over country default", () => {
    expect(devAdmin.resolveStoreTimeZone("America/New_York", "EG")).toBe("America/New_York");
  });

  it("explicit timeZone wins over BD default", () => {
    expect(devAdmin.resolveStoreTimeZone("Pacific/Auckland", "BD")).toBe("Pacific/Auckland");
  });

  it("unsupported country falls back to machine time zone", () => {
    const result = devAdmin.resolveStoreTimeZone(undefined, "US");
    expect(result).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("null timeZone falls through to country default", () => {
    expect(devAdmin.resolveStoreTimeZone(null, "EG")).toBe("Africa/Cairo");
  });
});

describe("storeSetup", () => {
  const baseConfig = {
    storeName: "Test Store",
    country: "EG",
    timeZone: null,
    currency: null,
  };

  it("EG setup payload has countryCode EG and timeZone Africa/Cairo", () => {
    const result = devAdmin.storeSetup(baseConfig);
    expect(result.countryCode).toBe("EG");
    expect(result.timeZone).toBe("Africa/Cairo");
    expect(result.storeName).toBe("Test Store");
    expect(result.currencyCode).toBeUndefined();
  });

  it("BD setup payload has countryCode BD and timeZone Asia/Dhaka", () => {
    const result = devAdmin.storeSetup({ ...baseConfig, country: "BD" });
    expect(result.countryCode).toBe("BD");
    expect(result.timeZone).toBe("Asia/Dhaka");
  });

  it("explicit timeZone overrides country default", () => {
    const result = devAdmin.storeSetup({ ...baseConfig, country: "EG", timeZone: "America/New_York" });
    expect(result.timeZone).toBe("America/New_York");
  });

  it("currency option is included in payload", () => {
    const result = devAdmin.storeSetup({ ...baseConfig, country: "EG", currency: "EGP" });
    expect(result.currencyCode).toBe("EGP");
  });

  it("uses module-level config when no override given", () => {
    const result = devAdmin.storeSetup();
    expect(result.countryCode).toBe("EG");
    expect(result.timeZone).toBe("Africa/Cairo");
  });
});

describe("isApiReady", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = undefined;
    }
  });

  it("returns true for slow successful response within timeout", async () => {
    vi.useFakeTimers();
    let resolveFetch;
    const fetchMock = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    globalThis.fetch = fetchMock;

    const promise = devAdmin.isApiReady("http://localhost:8787", 30_000);
    await vi.advanceTimersByTimeAsync(25_000);
    resolveFetch({ ok: true, status: 200 });
    const result = await promise;
    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns false when AbortSignal fires before response", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((_url, opts) => {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
      });
    });

    const promise = devAdmin.isApiReady("http://localhost:8787", 100);
    await vi.advanceTimersByTimeAsync(150);
    const result = await promise;
    expect(result).toBe(false);
  });

  it("returns false for non-2xx response (503)", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 503 }));
    const result = await devAdmin.isApiReady("http://localhost:8787");
    expect(result).toBe(false);
  });

  it("returns false for connection error", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("connect ECONNREFUSED")));
    const result = await devAdmin.isApiReady("http://localhost:8787");
    expect(result).toBe(false);
  });

  it("calls /api/v1/setup health endpoint", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200 }));
    await devAdmin.isApiReady("http://localhost:8787");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:8787/api/v1/setup",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });
});

describe("waitForApi", () => {
  it("throws when fetch always fails, bounded by 90s deadline", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("connect ECONNREFUSED")));

    const promise = devAdmin.waitForApi("http://localhost:8787");
    const rejection = expect(promise).rejects.toThrow(/Timed out waiting for API/);
    await vi.advanceTimersByTimeAsync(90_000);

    await rejection;
  });

  it("returns when fetch becomes ready", async () => {
    vi.useFakeTimers();
    let resolveFetch;
    const fetchMock = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    globalThis.fetch = fetchMock;

    const promise = devAdmin.waitForApi("http://localhost:8787");
    await vi.advanceTimersByTimeAsync(100);
    resolveFetch({ ok: true, status: 200 });
    await expect(promise).resolves.toBeUndefined();
  });

  it("throws promptly on child-process exit", async () => {
    vi.useFakeTimers();
    let resolveFetch;
    const fetchMock = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    globalThis.fetch = fetchMock;

    let childExitCalled = false;
    const promise = devAdmin.waitForApi("http://localhost:8787", () => {
      if (!childExitCalled) {
        childExitCalled = true;
        return null; // still running on first poll
      }
      return { code: 1 }; // exited on second poll
    });

    const rejection = expect(promise).rejects.toThrow(/exited before it was ready/);
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
  });

  it("cancels child-exit polling timer after each attempt", async () => {
    vi.useFakeTimers();
    let pollCount = 0;
    const getChildStatus = () => {
      pollCount++;
      return null;
    };

    globalThis.fetch = vi.fn(() => Promise.reject(new Error("connect ECONNREFUSED")));

    const promise = devAdmin.waitForApi("http://localhost:8787", getChildStatus);
    const rejection = expect(promise).rejects.toThrow(/Timed out waiting for API/);

    // Advance for a few iterations (each iteration sleeps 1000ms)
    await vi.advanceTimersByTimeAsync(3_000);
    const countAfter3s = pollCount;
    expect(countAfter3s).toBeGreaterThan(0);

    // Advance to near-deadline
    await vi.advanceTimersByTimeAsync(87_000);

    await rejection;

    // After the function settles, pollCount must not increase (timers cancelled)
    const finalCount = pollCount;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pollCount).toBe(finalCount);
  });
});

function makeSetupFetchMock() {
  let postBody;
  const fetchMock = vi.fn(async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/api/v1/setup") && opts.method === "GET") {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { adminExists: false } }) };
    }
    if (u.endsWith("/api/v1/setup") && opts.method === "POST") {
      postBody = opts.body;
      return { ok: true, status: 201, text: async () => JSON.stringify({ data: { userId: "123" } }) };
    }
    // syncLocalPlatform and other requests
    return { ok: true, status: 200, text: async () => JSON.stringify({ origins: { storefrontUrl: "http://localhost:4322", dashboardUrl: "http://localhost:4323" } }) };
  });
  return { fetchMock, getPostBody: () => postBody };
}

describe("setup request", () => {
  it("sends EG setup payload to POST /api/v1/setup", async () => {
    originalFetch = globalThis.fetch;
    const { fetchMock, getPostBody } = makeSetupFetchMock();
    globalThis.fetch = fetchMock;

    await devAdmin.createAdmin({ allowExisting: true });

    const postBody = getPostBody();
    expect(postBody).toBeDefined();
    const parsed = JSON.parse(postBody);
    expect(parsed.name).toBe("Local Admin");
    expect(parsed.email).toBe("admin@local.scalius.test");
    expect(parsed.store.countryCode).toBe("EG");
    expect(parsed.store.timeZone).toBe("Africa/Cairo");
    expect(parsed.store.storeName).toBe("Scalius Local");
  });

  it("sends BD setup payload when country is BD", async () => {
    vi.resetModules();
    const origEnv = process.env.LOCAL_STORE_COUNTRY;
    process.env.LOCAL_STORE_COUNTRY = "BD";

    try {
      const bdDevAdmin = await import("./dev-admin.mjs");

      originalFetch = globalThis.fetch;
      const { fetchMock, getPostBody } = makeSetupFetchMock();
      globalThis.fetch = fetchMock;

      await bdDevAdmin.createAdmin({ allowExisting: true });

      const postBody = getPostBody();
      expect(postBody).toBeDefined();
      const parsed = JSON.parse(postBody);
      expect(parsed.store.countryCode).toBe("BD");
      expect(parsed.store.timeZone).toBe("Asia/Dhaka");
    } finally {
      if (origEnv === undefined) {
        delete process.env.LOCAL_STORE_COUNTRY;
      } else {
        process.env.LOCAL_STORE_COUNTRY = origEnv;
      }
    }
  });
});
