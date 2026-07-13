const OPENVERSE_API = "https://api.openverse.org/v1/images/";
const USER_AGENT = "ScaliusCommerce-DemoAssetResearch/1.0 (https://scalius.com/contact)";
const MAX_QUERIES = 10;
const MAX_RESULTS = 8;
const MAX_RESPONSE_BYTES = 1_000_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

function httpsUrl(value) {
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function normalizeLicense(result) {
  const license = String(result.license ?? "").toLowerCase();
  const version = String(result.license_version ?? "").trim();
  if (license === "cc0") return { code: "CC0-1.0", version: version || "1.0", rejected: false };
  if (license === "pdm") return { code: "PDM-1.0", version: version || "1.0", rejected: false };
  if (license === "by" && version === "4.0") return { code: "CC-BY-4.0", version, rejected: false };
  return { code: null, version: version || null, rejected: true };
}

function fileExtension(result) {
  const declared = String(result.filetype ?? "").toLowerCase().replace(/^image\//, "");
  if (declared) return declared === "jpe" ? "jpg" : declared;
  try {
    return new URL(result.url).pathname.split(".").at(-1)?.toLowerCase() ?? "";
  } catch {
    return "";
  }
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
    originalFileReachable: null,
  };
}

function normalizeCandidate(result, logicalKey) {
  const license = normalizeLicense(result);
  const extension = fileExtension(result);
  const sourcePageUrl = httpsUrl(result.foreign_landing_url);
  const originalFileUrl = httpsUrl(result.url);
  const rejectionReasons = [];
  if (license.rejected) rejectionReasons.push("unknown-or-unsupported-license-version");
  if (!ALLOWED_EXTENSIONS.has(extension)) rejectionReasons.push("unsupported-image-extension");
  if (!sourcePageUrl) rejectionReasons.push("missing-https-source-page");
  if (!originalFileUrl) rejectionReasons.push("missing-https-original-url");
  if (!result.creator?.trim()) rejectionReasons.push("missing-creator");
  if (!Number.isInteger(result.width) || result.width <= 0 || !Number.isInteger(result.height) || result.height <= 0) rejectionReasons.push("missing-dimensions");
  if (result.mature === true) rejectionReasons.push("mature-result");

  return {
    logicalKey,
    openverseId: result.id ?? null,
    title: result.title?.trim() || "Untitled image",
    status: rejectionReasons.length ? "rejected" : "manual-review-required",
    rejectionReasons,
    sourceKind: "openverse-verified",
    sourcePageUrl,
    originalFileUrl,
    creator: result.creator?.trim() ?? "",
    creatorUrl: httpsUrl(result.creator_url),
    attribution: result.attribution?.trim() ?? "",
    license: {
      code: license.code,
      sourceCode: result.license ?? null,
      version: license.version,
      url: httpsUrl(result.license_url),
      attributionRequired: license.code === "CC-BY-4.0",
    },
    provider: result.provider ?? null,
    source: result.source ?? null,
    upstream: {
      extension,
      mime: extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`,
      bytes: Number.isInteger(result.filesize) && result.filesize > 0 ? result.filesize : null,
      width: result.width ?? null,
      height: result.height ?? null,
    },
    manualReview: emptyManualReview(),
    approval: {
      eligible: false,
      note: "Openverse index metadata is not approval. Verify the foreign landing page and downloaded bytes in the separate staging manifest.",
    },
  };
}

const REVIEW_REJECTIONS = Object.freeze({
  noWatermark: "manual-review-watermark",
  noVisibleBranding: "manual-review-visible-brand",
  noTrademarkedCharacter: "manual-review-trademarked-character",
  noIdentifiableEndorser: "manual-review-identifiable-endorser",
  optionAppearanceVerified: "manual-review-option-appearance-unverified",
  sourcePageLicenseVerified: "manual-review-source-license-unverified",
  originalFileReachable: "manual-review-original-file-unreachable",
});

export function applyOpenverseManualReview(candidate, review) {
  if (candidate.status === "rejected") return candidate;
  const reviewedBy = review?.reviewedBy?.trim();
  const reviewedAt = review?.reviewedAt;
  if (!reviewedBy || !/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt ?? "")) throw new Error("Manual review needs reviewedBy and a YYYY-MM-DD reviewedAt date");
  const rejectionReasons = Object.entries(REVIEW_REJECTIONS)
    .filter(([field]) => review[field] === false)
    .map(([, reason]) => reason);
  const incomplete = Object.keys(REVIEW_REJECTIONS).some((field) => review[field] !== true && review[field] !== false);
  return {
    ...candidate,
    status: rejectionReasons.length ? "rejected" : incomplete ? "manual-review-required" : "manual-review-complete",
    rejectionReasons: [...(candidate.rejectionReasons ?? []), ...rejectionReasons],
    manualReview: { ...emptyManualReview(), ...review, complete: !incomplete, reviewedBy, reviewedAt },
    approval: {
      eligible: false,
      note: "Manual review never approves an asset. Create a separate staging record after download and SHA-256 verification.",
    },
  };
}

export function buildOpenverseSearchUrl(query, limit) {
  const params = new URLSearchParams({
    q: query.trim(),
    page: "1",
    page_size: String(limit),
    mature: "false",
    filter_dead: "true",
    extension: "jpg,jpeg,png,webp",
    license: "cc0,pdm,by",
    license_type: "commercial,modification",
  });
  return `${OPENVERSE_API}?${params}`;
}

function validateQueries(queries) {
  if (!Array.isArray(queries) || queries.length === 0 || queries.length > MAX_QUERIES) throw new Error(`Discovery plan needs 1-${MAX_QUERIES} queries`);
  const seen = new Set();
  return queries.map((entry, index) => {
    const logicalKey = entry?.logicalKey?.trim();
    const query = entry?.query?.trim();
    const limit = entry?.limit ?? 5;
    if (!logicalKey || seen.has(logicalKey)) throw new Error(`queries[${index}].logicalKey is missing or duplicated`);
    if (!query || query.length > 200 || /[\r\n]/.test(query)) throw new Error(`queries[${index}].query must be 1-200 single-line characters`);
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
    if (declaredSize > MAX_RESPONSE_BYTES) throw new Error("Openverse response exceeds the 1 MB safety bound");
    if (response.ok) {
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Openverse response exceeds the 1 MB safety bound");
      return JSON.parse(text);
    }
    if (!RETRYABLE_STATUS.has(response.status) || attempt === 1) throw new Error(`Openverse API returned HTTP ${response.status}`);
    const retryAfter = Math.min(5, Math.max(1, Number(response.headers.get("retry-after") ?? 1)));
    await sleep(retryAfter * 1_000);
  }
  throw new Error("Openverse request failed");
}

export async function discoverOpenverseCandidates({
  queries,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => new Date(),
}) {
  const plan = validateQueries(queries);
  const reviewQueue = [];
  for (const [index, entry] of plan.entries()) {
    if (index > 0) await sleep(1_000);
    const payload = await fetchJson(buildOpenverseSearchUrl(entry.query, entry.limit), fetchImpl, sleep);
    const candidates = (payload.results ?? []).slice(0, entry.limit).map((result) => normalizeCandidate(result, entry.logicalKey));
    reviewQueue.push({
      logicalKey: entry.logicalKey,
      query: entry.query,
      requestedLimit: entry.limit,
      laterPagesIgnored: Number(payload.page_count ?? 1) > 1,
      warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
      candidates,
    });
  }
  const all = reviewQueue.flatMap((entry) => entry.candidates);
  return {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    source: "openverse-candidate-discovery",
    approvalAuthority: false,
    networkBehavior: "metadata-only; original and thumbnail image URLs were not fetched",
    reviewQueue,
    summary: {
      queries: reviewQueue.length,
      candidates: all.length,
      manualReviewRequired: all.filter((candidate) => candidate.status === "manual-review-required").length,
      rejected: all.filter((candidate) => candidate.status === "rejected").length,
    },
  };
}

export const OPENVERSE_DISCOVERY_POLICY = Object.freeze({
  endpoint: OPENVERSE_API,
  userAgent: USER_AGENT,
  maxQueries: MAX_QUERIES,
  maxResultsPerQuery: MAX_RESULTS,
  interQueryDelayMs: 1_000,
});
