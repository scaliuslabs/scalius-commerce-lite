import { describe, expect, it, vi } from "vitest";

import {
  applyOpenverseManualReview,
  buildOpenverseSearchUrl,
  discoverOpenverseCandidates,
  OPENVERSE_DISCOVERY_POLICY,
} from "./discovery.mjs";

function image(overrides = {}) {
  return {
    id: "4bc43a04-ef46-4544-a0c1-63c63f56e276",
    title: "Neutral useful object",
    foreign_landing_url: "https://example-source.org/works/useful-object",
    url: "https://cdn.example-source.org/useful-object.jpg",
    creator: "A. Maker",
    creator_url: "https://example-source.org/people/maker",
    license: "by",
    license_version: "4.0",
    license_url: "https://creativecommons.org/licenses/by/4.0/",
    provider: "wikimedia",
    source: "wikimedia",
    filesize: 456789,
    filetype: "jpg",
    attribution: '"Neutral useful object" by A. Maker is licensed CC BY 4.0.',
    mature: false,
    height: 1600,
    width: 2400,
    thumbnail: "https://api.openverse.org/v1/images/id/thumb/",
    ...overrides,
  };
}

function response(payload, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(payload),
  };
}

describe("Openverse candidate discovery", () => {
  it("builds the exact bounded anonymous image filters", () => {
    const url = new URL(buildOpenverseSearchUrl("neutral ceramic vase", 5));
    expect(url.origin).toBe("https://api.openverse.org");
    expect(url.pathname).toBe("/v1/images/");
    expect(url.searchParams.get("q")).toBe("neutral ceramic vase");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("page_size")).toBe("5");
    expect(url.searchParams.get("mature")).toBe("false");
    expect(url.searchParams.get("filter_dead")).toBe("true");
    expect(url.searchParams.get("extension")).toBe("jpg,jpeg,png,webp");
    expect(url.searchParams.get("license")).toBe("cc0,pdm,by");
    expect(url.searchParams.get("license_type")).toBe("commercial,modification");
    expect(OPENVERSE_DISCOVERY_POLICY).toMatchObject({ maxQueries: 10, maxResultsPerQuery: 8 });
  });

  it("preserves provider provenance but never downloads or approves", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      result_count: 50,
      page_count: 10,
      page_size: 5,
      page: 1,
      results: [image()],
    }));
    const queue = await discoverOpenverseCandidates({
      queries: [{ logicalKey: "noor-ceramic-vase:lifestyle", query: "neutral ceramic vase", limit: 5 }],
      fetchImpl: fetchMock,
      sleep: vi.fn(),
      now: () => new Date("2026-07-13T00:00:00.000Z"),
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [requestedUrl, request] = fetchMock.mock.calls[0];
    expect(requestedUrl).toMatch(/^https:\/\/api\.openverse\.org\/v1\/images\//);
    expect(request.headers["User-Agent"]).toContain("ScaliusCommerce-DemoAssetResearch");
    expect(queue).toMatchObject({
      approvalAuthority: false,
      networkBehavior: "metadata-only; original and thumbnail image URLs were not fetched",
      summary: { queries: 1, candidates: 1, manualReviewRequired: 1, rejected: 0 },
    });
    expect(queue.reviewQueue[0].laterPagesIgnored).toBe(true);
    expect(queue.reviewQueue[0].candidates[0]).toMatchObject({
      status: "manual-review-required",
      sourceKind: "openverse-verified",
      sourcePageUrl: "https://example-source.org/works/useful-object",
      originalFileUrl: "https://cdn.example-source.org/useful-object.jpg",
      creator: "A. Maker",
      attribution: expect.stringContaining("CC BY 4.0"),
      license: {
        code: "CC-BY-4.0",
        version: "4.0",
        url: "https://creativecommons.org/licenses/by/4.0/",
        attributionRequired: true,
      },
      provider: "wikimedia",
      source: "wikimedia",
      upstream: { width: 2400, height: 1600, extension: "jpg" },
      manualReview: { complete: false, sourcePageLicenseVerified: null },
      approval: { eligible: false },
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("cdn.example-source.org"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/thumb/"))).toBe(false);
  });

  it("rejects unsupported licenses, versions, extensions, maturity, and incomplete provenance", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      results: [
        image({ license: "by-sa" }),
        image({ license: "by", license_version: "3.0" }),
        image({ filetype: "svg" }),
        image({ mature: true }),
        image({ creator: "", foreign_landing_url: null }),
      ],
    }));
    const queue = await discoverOpenverseCandidates({
      queries: [{ logicalKey: "category:home:image", query: "calm home", limit: 5 }],
      fetchImpl: fetchMock,
      sleep: vi.fn(),
    });
    const candidates = queue.reviewQueue[0].candidates;
    expect(candidates.every((candidate) => candidate.status === "rejected")).toBe(true);
    expect(candidates[0].rejectionReasons).toContain("unknown-or-unsupported-license-version");
    expect(candidates[1].rejectionReasons).toContain("unknown-or-unsupported-license-version");
    expect(candidates[2].rejectionReasons).toContain("unsupported-image-extension");
    expect(candidates[3].rejectionReasons).toContain("mature-result");
    expect(candidates[4].rejectionReasons).toEqual(expect.arrayContaining(["missing-creator", "missing-https-source-page"]));
  });

  it("converts failed source-page and visual checks to rejection without approval", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ results: [image({ license: "cc0", license_version: "1.0" })] }));
    const queue = await discoverOpenverseCandidates({
      queries: [{ logicalKey: "asset", query: "neutral object", limit: 1 }],
      fetchImpl: fetchMock,
      sleep: vi.fn(),
    });
    const reviewed = applyOpenverseManualReview(queue.reviewQueue[0].candidates[0], {
      reviewedBy: "rights-reviewer",
      reviewedAt: "2026-07-13",
      noWatermark: true,
      noVisibleBranding: false,
      noTrademarkedCharacter: true,
      noIdentifiableEndorser: true,
      optionAppearanceVerified: true,
      sourcePageLicenseVerified: false,
      originalFileReachable: true,
    });
    expect(reviewed.status).toBe("rejected");
    expect(reviewed.rejectionReasons).toEqual(expect.arrayContaining([
      "manual-review-visible-brand",
      "manual-review-source-license-unverified",
    ]));
    expect(reviewed.approval.eligible).toBe(false);
  });

  it("runs sequentially with a bounded retry and rejects unbounded plans", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 503, { "retry-after": "20" }))
      .mockResolvedValueOnce(response({ results: [image({ license: "pdm", license_version: "1.0" })] }))
      .mockResolvedValueOnce(response({ results: [image({ license: "cc0", license_version: "1.0" })] }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const queue = await discoverOpenverseCandidates({
      queries: [
        { logicalKey: "asset:one", query: "first object", limit: 1 },
        { logicalKey: "asset:two", query: "second object", limit: 1 },
      ],
      fetchImpl: fetchMock,
      sleep,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[5_000], [1_000]]);
    expect(queue.summary).toMatchObject({ queries: 2, candidates: 2, rejected: 0 });

    await expect(discoverOpenverseCandidates({
      queries: [{ logicalKey: "bad", query: "x", limit: 9 }],
      fetchImpl: vi.fn(),
    })).rejects.toThrow("limit must be 1-8");
  });
});
