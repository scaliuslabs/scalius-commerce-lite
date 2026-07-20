import { describe, expect, it, vi } from "vitest";

import {
  applyCommonsManualReview,
  buildCommonsSearchUrl,
  COMMONS_DISCOVERY_POLICY,
  discoverCommonsCandidates,
} from "./discovery.mjs";

function metadata(value) {
  return { value };
}

function page({
  title = "File:Useful object.jpg",
  mime = "image/jpeg",
  license = "CC BY 4.0",
  licenseUrl = "https://creativecommons.org/licenses/by/4.0/",
} = {}) {
  return {
    pageid: 42,
    ns: 6,
    title,
    imageinfo: [{
      url: "https://upload.wikimedia.org/useful-object.jpg",
      descriptionurl: "https://commons.wikimedia.org/wiki/File:Useful_object.jpg",
      size: 345678,
      width: 2400,
      height: 1600,
      mime,
      sha1: "commonsbase36sha1",
      extmetadata: {
        Artist: metadata("<a href='/wiki/User:Maker'>A. Maker</a>"),
        Credit: metadata("Own work"),
        LicenseShortName: metadata(license),
        LicenseUrl: metadata(licenseUrl),
        AttributionRequired: metadata("true"),
        ImageDescription: metadata("A neutral useful object on a table"),
      },
    }],
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

describe("Wikimedia Commons candidate discovery", () => {
  it("builds a bounded bitmap-only metadata request", () => {
    const url = new URL(buildCommonsSearchUrl("neutral ceramic vase", 5));
    expect(url.origin).toBe("https://commons.wikimedia.org");
    expect(url.searchParams.get("generator")).toBe("search");
    expect(url.searchParams.get("gsrsearch")).toBe("neutral ceramic vase filetype:bitmap");
    expect(url.searchParams.get("gsrnamespace")).toBe("6");
    expect(url.searchParams.get("gsrlimit")).toBe("5");
    expect(url.searchParams.get("iiprop")).toBe("url|size|mime|sha1|extmetadata");
    expect(url.searchParams.get("iiextmetadatafilter")).toBe(
      "Artist|Credit|LicenseShortName|LicenseUrl|UsageTerms|AttributionRequired|ImageDescription",
    );
    expect(url.searchParams.get("maxlag")).toBe("5");
    expect(COMMONS_DISCOVERY_POLICY.maxResultsPerQuery).toBe(8);
    expect(COMMONS_DISCOVERY_POLICY.maxQueries).toBe(10);
  });

  it("emits metadata-only candidates that always require manual review", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      continue: { gsroffset: 5, continue: "gsroffset||" },
      query: { pages: [page()] },
    }));
    const queue = await discoverCommonsCandidates({
      queries: [{ logicalKey: "noor-ceramic-vase:lifestyle", query: "neutral ceramic vase", limit: 5 }],
      fetchImpl: fetchMock,
      sleep: vi.fn(),
      now: () => new Date("2026-07-13T00:00:00.000Z"),
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [requestedUrl, request] = fetchMock.mock.calls[0];
    expect(requestedUrl).toMatch(/^https:\/\/commons\.wikimedia\.org\/w\/api\.php\?/);
    expect(request.headers["User-Agent"]).toContain("ScaliusCommerce-DemoAssetResearch");
    expect(queue).toMatchObject({
      approvalAuthority: false,
      networkBehavior: "metadata-only; candidate image URLs were not fetched",
      summary: { queries: 1, candidates: 1, manualReviewRequired: 1, rejected: 0 },
    });
    const entry = queue.reviewQueue[0];
    expect(entry.continuationIgnored).toBe(true);
    expect(entry.candidates[0]).toMatchObject({
      status: "manual-review-required",
      sourcePageUrl: "https://commons.wikimedia.org/wiki/File:Useful_object.jpg",
      originalFileUrl: "https://upload.wikimedia.org/useful-object.jpg",
      creator: "A. Maker",
      license: {
        code: "CC-BY-4.0",
        url: "https://creativecommons.org/licenses/by/4.0/",
        attributionRequired: true,
      },
      upstream: { mime: "image/jpeg", width: 2400, height: 1600 },
      manualReview: {
        complete: false,
        noWatermark: null,
        noVisibleBranding: null,
        noIdentifiableEndorser: null,
      },
      approval: { eligible: false },
    });
    expect(fetchMock.mock.calls.some(([url]) => new URL(String(url)).hostname === "upload.wikimedia.org")).toBe(false);
  });

  it("rejects share-alike, GFDL, unknown, and non-platform image candidates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      query: {
        pages: [
          page({ title: "File:Share alike.jpg", license: "CC BY-SA 4.0" }),
          page({ title: "File:GFDL.jpg", license: "GFDL 1.2" }),
          page({ title: "File:Unknown.jpg", license: "Custom free license" }),
          page({ title: "File:Document.pdf", mime: "application/pdf", license: "CC0 1.0" }),
        ],
      },
    }));
    const queue = await discoverCommonsCandidates({
      queries: [{ logicalKey: "category:home:image", query: "calm home objects", limit: 4 }],
      fetchImpl: fetchMock,
      sleep: vi.fn(),
    });
    const candidates = queue.reviewQueue[0].candidates;
    expect(candidates.every((candidate) => candidate.status === "rejected")).toBe(true);
    expect(candidates[0].rejectionReasons).toContain("share-alike-license");
    expect(candidates[1].rejectionReasons).toContain("gfdl-license");
    expect(candidates[2].rejectionReasons).toContain("unknown-or-unsupported-license");
    expect(candidates[3].rejectionReasons).toContain("unsupported-or-non-image-mime");
  });

  it("turns failed visual review flags into rejection without granting approval", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      query: { pages: [page()] },
    }));
    const queue = await discoverCommonsCandidates({
      queries: [{ logicalKey: "asset", query: "neutral object", limit: 1 }],
      fetchImpl: fetchMock,
      sleep: vi.fn(),
    });
    const reviewed = applyCommonsManualReview(queue.reviewQueue[0].candidates[0], {
      reviewedBy: "rights-reviewer",
      reviewedAt: "2026-07-13",
      noWatermark: true,
      noVisibleBranding: false,
      noTrademarkedCharacter: true,
      noIdentifiableEndorser: false,
      optionAppearanceVerified: true,
      sourcePageLicenseVerified: true,
    });

    expect(reviewed.status).toBe("rejected");
    expect(reviewed.rejectionReasons).toEqual(expect.arrayContaining([
      "manual-review-visible-brand",
      "manual-review-identifiable-endorser",
    ]));
    expect(reviewed.approval.eligible).toBe(false);
  });

  it("runs queries sequentially, waits between them, and retries only bounded transient failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 429, { "retry-after": "20" }))
      .mockResolvedValueOnce(response({ query: { pages: [page({ license: "CC0 1.0" })] } }))
      .mockResolvedValueOnce(response({ query: { pages: [page({ license: "Public domain" })] } }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const queue = await discoverCommonsCandidates({
      queries: [
        { logicalKey: "asset:one", query: "first neutral object", limit: 1 },
        { logicalKey: "asset:two", query: "second neutral object", limit: 1 },
      ],
      fetchImpl: fetchMock,
      sleep,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[5_000], [1_000]]);
    expect(queue.summary).toMatchObject({ queries: 2, candidates: 2, rejected: 0 });
  });

  it("rejects broad or unbounded plans before a request", async () => {
    const fetchMock = vi.fn();
    await expect(discoverCommonsCandidates({
      queries: [{ logicalKey: "asset", query: "x", limit: 9 }],
      fetchImpl: fetchMock,
    })).rejects.toThrow("limit must be 1-8");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
