const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT = "ScaliusCommerce-DemoAssetResearch/1.0 (https://scalius.com/contact)";
const MAX_QUERIES = 10;
const MAX_RESULTS = 8;
const MAX_RESPONSE_BYTES = 1_000_000;
const RETRYABLE_STATUS = new Set([429, 503]);
const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const EXTMETADATA_FIELDS = [
  "Artist",
  "Credit",
  "LicenseShortName",
  "LicenseUrl",
  "UsageTerms",
  "AttributionRequired",
  "ImageDescription",
];

function metadataValue(metadata, key) {
  const value = metadata?.[key]?.value;
  return typeof value === "string" ? plainText(value) : "";
}

function plainText(value) {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLicense(metadata) {
  const shortName = metadataValue(metadata, "LicenseShortName");
  const usageTerms = metadataValue(metadata, "UsageTerms");
  const combined = `${shortName} ${usageTerms}`.toLowerCase();
  if (/cc\s*by[- ]sa|creative commons attribution[- ]sharealike/.test(combined)) {
    return { code: null, decision: "reject", reason: "share-alike-license", shortName };
  }
  if (/gfdl|gnu free documentation/.test(combined)) {
    return { code: null, decision: "reject", reason: "gfdl-license", shortName };
  }
  if (/cc0|creative commons zero/.test(combined)) {
    return { code: "CC0-1.0", decision: "review", reason: null, shortName };
  }
  if (/public domain|public domain mark|pdm/.test(combined)) {
    return { code: "PDM-1.0", decision: "review", reason: null, shortName };
  }
  if (/cc\s*by\s*4\.0|cc-by-4\.0|attribution 4\.0/.test(combined)) {
    return { code: "CC-BY-4.0", decision: "review", reason: null, shortName };
  }
  return { code: null, decision: "reject", reason: "unknown-or-unsupported-license", shortName };
}

function normalizeCandidate(page, logicalKey) {
  const info = page.imageinfo?.[0];
  if (!info) {
    return {
      logicalKey,
      title: page.title ?? "Unknown file",
      status: "rejected",
      rejectionReasons: ["missing-imageinfo"],
      manualReview: emptyManualReview(),
    };
  }
  const metadata = info.extmetadata ?? {};
  const license = normalizeLicense(metadata);
  const rejectionReasons = [];
  if (!ALLOWED_MIMES.has(info.mime)) rejectionReasons.push("unsupported-or-non-image-mime");
  if (!Number.isInteger(info.width) || info.width <= 0 || !Number.isInteger(info.height) || info.height <= 0) rejectionReasons.push("missing-dimensions");
  if (!Number.isInteger(info.size) || info.size <= 0) rejectionReasons.push("missing-byte-size");
  if (!/^https:\/\//.test(info.url ?? "") || !/^https:\/\//.test(info.descriptionurl ?? "")) rejectionReasons.push("missing-https-source-url");
  if (license.decision === "reject") rejectionReasons.push(license.reason);
  const creator = metadataValue(metadata, "Artist") || metadataValue(metadata, "Credit");
  if (!creator) rejectionReasons.push("missing-creator");
  const attributionRequired = license.code === "CC-BY-4.0" || /true|yes|1/i.test(metadataValue(metadata, "AttributionRequired"));

  return {
    logicalKey,
    title: page.title,
    status: rejectionReasons.length ? "rejected" : "manual-review-required",
    rejectionReasons,
    sourceKind: "wikimedia-commons",
    sourcePageUrl: info.descriptionurl ?? null,
    originalFileUrl: info.url ?? null,
    creator,
    license: {
      code: license.code,
      shortName: license.shortName,
      url: metadataValue(metadata, "LicenseUrl") || null,
      attributionRequired,
      attributionText: attributionRequired
        ? [creator, metadataValue(metadata, "Credit")].filter(Boolean).join(" — ")
        : "",
    },
    upstream: {
      sha1: typeof info.sha1 === "string" ? info.sha1 : null,
      mime: info.mime ?? null,
      bytes: info.size ?? null,
      width: info.width ?? null,
      height: info.height ?? null,
    },
    description: metadataValue(metadata, "ImageDescription"),
    manualReview: emptyManualReview(),
    approval: {
      eligible: false,
      note: "Discovery output cannot approve or stage an asset. Download and SHA-256 verification happen in the separate staging manifest.",
    },
  };
}

function emptyManualReview() {
  return {
    complete: false,
    reviewedBy: null,
    reviewedAt: null,
    noWatermark: null,
    noVisibleBranding: null,
    noTrademarkedCharacter: null,
    noIdentifiableEndorser: null,
    optionAppearanceVerified: null,
    sourcePageLicenseVerified: null,
  };
}

const MANUAL_REVIEW_REJECTIONS = Object.freeze({
  noWatermark: "manual-review-watermark",
  noVisibleBranding: "manual-review-visible-brand",
  noTrademarkedCharacter: "manual-review-trademarked-character",
  noIdentifiableEndorser: "manual-review-identifiable-endorser",
  optionAppearanceVerified: "manual-review-option-appearance-unverified",
  sourcePageLicenseVerified: "manual-review-source-license-unverified",
});

export function applyCommonsManualReview(candidate, review) {
  if (candidate.status === "rejected") return candidate;
  const reviewedBy = review?.reviewedBy?.trim();
  const reviewedAt = review?.reviewedAt;
  if (!reviewedBy || !/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt ?? "")) {
    throw new Error("Manual review needs reviewedBy and a YYYY-MM-DD reviewedAt date");
  }
  const rejectionReasons = Object.entries(MANUAL_REVIEW_REJECTIONS)
    .filter(([field]) => review[field] === false)
    .map(([, reason]) => reason);
  const incomplete = Object.keys(MANUAL_REVIEW_REJECTIONS).some(
    (field) => review[field] !== true && review[field] !== false,
  );
  return {
    ...candidate,
    status: rejectionReasons.length
      ? "rejected"
      : incomplete
        ? "manual-review-required"
        : "manual-review-complete",
    rejectionReasons: [...(candidate.rejectionReasons ?? []), ...rejectionReasons],
    manualReview: {
      ...emptyManualReview(),
      ...review,
      complete: !incomplete,
      reviewedBy,
      reviewedAt,
    },
    approval: {
      eligible: false,
      note: "Manual review never approves an asset. Create a separate staging record after downloading and verifying SHA-256.",
    },
  };
}

export function buildCommonsSearchUrl(query, limit) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: `${query.trim()} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: String(limit),
    prop: "imageinfo",
    iilimit: "1",
    iiprop: "url|size|mime|sha1|extmetadata",
    iiextmetadatalanguage: "en",
    iiextmetadatafilter: EXTMETADATA_FIELDS.join("|"),
    maxlag: "5",
  });
  return `${COMMONS_API}?${params}`;
}

function validateQueries(queries) {
  if (!Array.isArray(queries) || queries.length === 0 || queries.length > MAX_QUERIES) throw new Error(`Discovery plan needs 1-${MAX_QUERIES} queries`);
  const seen = new Set();
  return queries.map((entry, index) => {
    const logicalKey = entry?.logicalKey?.trim();
    const query = entry?.query?.trim();
    const limit = entry?.limit ?? 5;
    if (!logicalKey || seen.has(logicalKey)) throw new Error(`queries[${index}].logicalKey is missing or duplicated`);
    if (!query || query.length > 120 || /[\r\n]/.test(query)) throw new Error(`queries[${index}].query must be 1-120 single-line characters`);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new Error(`queries[${index}].limit must be 1-${MAX_RESULTS}`);
    seen.add(logicalKey);
    return { logicalKey, query, limit };
  });
}

async function fetchJson(url, fetchImpl, sleep) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > MAX_RESPONSE_BYTES) throw new Error("Commons response exceeds the 1 MB safety bound");
    if (response.ok) {
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Commons response exceeds the 1 MB safety bound");
      return JSON.parse(text);
    }
    if (!RETRYABLE_STATUS.has(response.status) || attempt === 1) throw new Error(`Commons API returned HTTP ${response.status}`);
    const retryAfter = Math.min(5, Math.max(1, Number(response.headers.get("retry-after") ?? 1)));
    await sleep(retryAfter * 1_000);
  }
  throw new Error("Commons request failed");
}

export async function discoverCommonsCandidates({
  queries,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => new Date(),
}) {
  const plan = validateQueries(queries);
  const reviewQueue = [];
  for (const [index, entry] of plan.entries()) {
    if (index > 0) await sleep(1_000);
    const url = buildCommonsSearchUrl(entry.query, entry.limit);
    const payload = await fetchJson(url, fetchImpl, sleep);
    if (payload.error) throw new Error(`Commons API error: ${payload.error.code ?? "unknown"}`);
    const candidates = (payload.query?.pages ?? [])
      .slice(0, entry.limit)
      .map((page) => normalizeCandidate(page, entry.logicalKey));
    reviewQueue.push({
      logicalKey: entry.logicalKey,
      query: entry.query,
      requestedLimit: entry.limit,
      continuationIgnored: Boolean(payload.continue),
      candidates,
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    source: "wikimedia-commons-candidate-discovery",
    approvalAuthority: false,
    networkBehavior: "metadata-only; candidate image URLs were not fetched",
    reviewQueue,
    summary: {
      queries: reviewQueue.length,
      candidates: reviewQueue.flatMap((entry) => entry.candidates).length,
      manualReviewRequired: reviewQueue.flatMap((entry) => entry.candidates).filter((candidate) => candidate.status === "manual-review-required").length,
      rejected: reviewQueue.flatMap((entry) => entry.candidates).filter((candidate) => candidate.status === "rejected").length,
    },
  };
}

export const COMMONS_DISCOVERY_POLICY = Object.freeze({
  endpoint: COMMONS_API,
  userAgent: USER_AGENT,
  maxQueries: MAX_QUERIES,
  maxResultsPerQuery: MAX_RESULTS,
  interQueryDelayMs: 1_000,
});
