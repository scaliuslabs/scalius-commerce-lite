const TURSO_PLATFORM_API_BASE = "https://api.turso.tech/v1";

export interface TursoUploadTarget {
  databaseId: string;
  databaseName: string;
  hostname: string;
  databaseUrl: string;
}

export interface TursoStoragePreflight {
  organization: string;
  plan: string;
  overagesEnabled: boolean;
  quotaBytes: number;
  usedBytes: number;
  availableBytes: number;
  artifactBytes: number;
  requiresOverage: boolean;
}

export interface TursoLoadBudgetPreflight {
  organization: string;
  plan: string;
  overagesEnabled: boolean;
  rowsReadQuota: number;
  rowsReadUsed: number;
  rowsReadAvailable: number;
  rowsReadBudget: number;
  rowsWrittenQuota: number;
  rowsWrittenUsed: number;
  rowsWrittenAvailable: number;
  rowsWrittenBudget: number;
  requiresOverage: boolean;
}

export interface TursoPlatformUploadOptions {
  organization: string;
  databaseName: string;
  platformToken: string;
  fetchImpl?: typeof fetch;
}

export interface ProvisionTursoUploadTargetOptions
  extends TursoPlatformUploadOptions {
  group: string;
}

function requireSlug(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(normalized)) {
    throw new Error(
      `${label} must contain only lowercase letters, numbers, and internal dashes.`,
    );
  }
  return normalized;
}

function requireToken(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${label} must be a non-empty single-line token.`);
  }
  return normalized;
}

function platformUrl(input: TursoPlatformUploadOptions, suffix = ""): string {
  const organization = requireSlug(input.organization, "organization");
  const databaseName = requireSlug(input.databaseName, "databaseName");
  return `${TURSO_PLATFORM_API_BASE}/organizations/${organization}/databases/${databaseName}${suffix}`;
}

function organizationUrl(organization: string, suffix: string): string {
  return `${TURSO_PLATFORM_API_BASE}/organizations/${requireSlug(organization, "organization")}${suffix}`;
}

async function providerError(response: Response): Promise<Error> {
  const detail = (await response.text()).slice(0, 1_000).trim();
  return new Error(
    `Turso Platform API returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
  );
}

function authorizationHeaders(platformToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${requireToken(platformToken, "platformToken")}`,
  };
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Turso ${label} must be a non-negative safe integer.`);
  }
  return Number(value);
}

export async function preflightTursoUploadStorage(input: {
  organization: string;
  platformToken: string;
  artifactBytes: number;
  allowStorageOverage?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<TursoStoragePreflight> {
  const organization = requireSlug(input.organization, "organization");
  const artifactBytes = requireNonNegativeSafeInteger(
    input.artifactBytes,
    "artifact bytes",
  );
  const request = input.fetchImpl ?? fetch;
  const headers = authorizationHeaders(input.platformToken);
  const [subscriptionResponse, usageResponse, plansResponse] = await Promise.all([
    request(organizationUrl(organization, "/subscription"), { headers }),
    request(organizationUrl(organization, "/usage"), { headers }),
    request(`${TURSO_PLATFORM_API_BASE}/plans`, { headers }),
  ]);
  if (!subscriptionResponse.ok) throw await providerError(subscriptionResponse);
  if (!usageResponse.ok) throw await providerError(usageResponse);
  if (!plansResponse.ok) throw await providerError(plansResponse);

  const subscriptionPayload = await subscriptionResponse.json() as {
    subscription?: { plan?: unknown; overages?: unknown };
  };
  const usagePayload = await usageResponse.json() as {
    organization?: { usage?: { storage_bytes?: unknown } };
  };
  const plansPayload = await plansResponse.json() as {
    plans?: Array<{ name?: unknown; quotas?: { storage?: unknown } }>;
  };
  const plan = String(subscriptionPayload.subscription?.plan ?? "")
    .trim()
    .toLowerCase();
  const overagesEnabled = subscriptionPayload.subscription?.overages === true;
  const matchingPlan = plansPayload.plans?.find((candidate) =>
    String(candidate.name ?? "").trim().toLowerCase() === plan
  );
  if (!plan || !matchingPlan) {
    throw new Error("Turso storage preflight could not resolve the active plan quota.");
  }
  const quotaBytes = requireNonNegativeSafeInteger(
    matchingPlan.quotas?.storage,
    "plan storage quota",
  );
  const usedBytes = requireNonNegativeSafeInteger(
    usagePayload.organization?.usage?.storage_bytes ?? 0,
    "organization storage usage",
  );
  const availableBytes = Math.max(0, quotaBytes - usedBytes);
  const requiresOverage = artifactBytes > availableBytes;
  const result: TursoStoragePreflight = {
    organization,
    plan,
    overagesEnabled,
    quotaBytes,
    usedBytes,
    availableBytes,
    artifactBytes,
    requiresOverage,
  };
  if (requiresOverage && !overagesEnabled) {
    throw new Error(
      `Turso storage preflight refused the upload: ${artifactBytes} artifact bytes exceed ${availableBytes} available bytes and overages are disabled.`,
    );
  }
  if (requiresOverage && !input.allowStorageOverage) {
    throw new Error(
      "Turso storage preflight requires --allow-storage-overage before a billable upload.",
    );
  }
  return result;
}

/**
 * Reserve an explicit organization-level usage envelope before a live load
 * run. Turso meters row scans and writes across every database in the same
 * organization, so a disposable database alone is not a production-safe
 * benchmark boundary.
 */
export async function preflightTursoLoadBudget(input: {
  organization: string;
  platformToken: string;
  rowsReadBudget: number;
  rowsWrittenBudget: number;
  allowUsageOverage?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<TursoLoadBudgetPreflight> {
  const organization = requireSlug(input.organization, "organization");
  const rowsReadBudget = requireNonNegativeSafeInteger(
    input.rowsReadBudget,
    "load-test row-read budget",
  );
  const rowsWrittenBudget = requireNonNegativeSafeInteger(
    input.rowsWrittenBudget,
    "load-test row-write budget",
  );
  if (rowsReadBudget < 1 || rowsWrittenBudget < 1) {
    throw new Error("Turso load-test row budgets must both be positive.");
  }

  const request = input.fetchImpl ?? fetch;
  const headers = authorizationHeaders(input.platformToken);
  const [subscriptionResponse, usageResponse, plansResponse] = await Promise.all([
    request(organizationUrl(organization, "/subscription"), { headers }),
    request(organizationUrl(organization, "/usage"), { headers }),
    request(`${TURSO_PLATFORM_API_BASE}/plans`, { headers }),
  ]);
  if (!subscriptionResponse.ok) throw await providerError(subscriptionResponse);
  if (!usageResponse.ok) throw await providerError(usageResponse);
  if (!plansResponse.ok) throw await providerError(plansResponse);

  const subscriptionPayload = await subscriptionResponse.json() as {
    subscription?: { plan?: unknown; overages?: unknown };
  };
  const usagePayload = await usageResponse.json() as {
    organization?: {
      usage?: { rows_read?: unknown; rows_written?: unknown };
    };
  };
  const plansPayload = await plansResponse.json() as {
    plans?: Array<{
      name?: unknown;
      quotas?: { rowsRead?: unknown; rowsWritten?: unknown };
    }>;
  };
  const plan = String(subscriptionPayload.subscription?.plan ?? "")
    .trim()
    .toLowerCase();
  const overagesEnabled = subscriptionPayload.subscription?.overages === true;
  const matchingPlan = plansPayload.plans?.find((candidate) =>
    String(candidate.name ?? "").trim().toLowerCase() === plan
  );
  if (!plan || !matchingPlan) {
    throw new Error("Turso load preflight could not resolve the active plan quota.");
  }

  const rowsReadQuota = requireNonNegativeSafeInteger(
    matchingPlan.quotas?.rowsRead,
    "plan row-read quota",
  );
  const rowsWrittenQuota = requireNonNegativeSafeInteger(
    matchingPlan.quotas?.rowsWritten,
    "plan row-write quota",
  );
  const rowsReadUsed = requireNonNegativeSafeInteger(
    usagePayload.organization?.usage?.rows_read,
    "organization rows read",
  );
  const rowsWrittenUsed = requireNonNegativeSafeInteger(
    usagePayload.organization?.usage?.rows_written,
    "organization rows written",
  );
  const rowsReadAvailable = Math.max(0, rowsReadQuota - rowsReadUsed);
  const rowsWrittenAvailable = Math.max(0, rowsWrittenQuota - rowsWrittenUsed);
  const requiresOverage = rowsReadBudget > rowsReadAvailable
    || rowsWrittenBudget > rowsWrittenAvailable;
  const result: TursoLoadBudgetPreflight = {
    organization,
    plan,
    overagesEnabled,
    rowsReadQuota,
    rowsReadUsed,
    rowsReadAvailable,
    rowsReadBudget,
    rowsWrittenQuota,
    rowsWrittenUsed,
    rowsWrittenAvailable,
    rowsWrittenBudget,
    requiresOverage,
  };
  if (requiresOverage && !overagesEnabled) {
    throw new Error(
      `Turso load preflight refused the run: requested budgets require ${rowsReadBudget} row reads and ${rowsWrittenBudget} row writes, but only ${rowsReadAvailable} reads and ${rowsWrittenAvailable} writes remain and overages are disabled.`,
    );
  }
  if (requiresOverage && !input.allowUsageOverage) {
    throw new Error(
      "Turso load preflight requires an explicit usage-overage acknowledgement before a billable run.",
    );
  }
  return result;
}

export async function provisionTursoUploadTarget(
  options: ProvisionTursoUploadTargetOptions,
): Promise<TursoUploadTarget> {
  const organization = requireSlug(options.organization, "organization");
  const databaseName = requireSlug(options.databaseName, "databaseName");
  const group = requireSlug(options.group, "group");
  const request = options.fetchImpl ?? fetch;
  const response = await request(
    `${TURSO_PLATFORM_API_BASE}/organizations/${organization}/databases`,
    {
      method: "POST",
      headers: {
        ...authorizationHeaders(options.platformToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: databaseName,
        group,
        seed: { type: "database_upload" },
        use_tursodb: true,
      }),
    },
  );
  if (!response.ok) throw await providerError(response);

  const payload = await response.json() as {
    database?: {
      DbId?: unknown;
      Hostname?: unknown;
      Name?: unknown;
    };
  };
  const databaseId = String(payload.database?.DbId ?? "").trim();
  const returnedName = String(payload.database?.Name ?? "").trim().toLowerCase();
  const hostname = String(payload.database?.Hostname ?? "").trim().toLowerCase();
  if (
    !databaseId ||
    returnedName !== databaseName ||
    !/^[a-z0-9.-]+\.turso\.io$/.test(hostname)
  ) {
    throw new Error("Turso returned an invalid upload-target identity.");
  }
  return {
    databaseId,
    databaseName,
    hostname,
    databaseUrl: `https://${hostname}`,
  };
}

export async function mintTursoUploadToken(
  options: TursoPlatformUploadOptions,
): Promise<string> {
  const request = options.fetchImpl ?? fetch;
  const url = new URL(platformUrl(options, "/auth/tokens"));
  url.searchParams.set("expiration", "1d");
  url.searchParams.set("authorization", "full-access");
  const response = await request(url, {
    method: "POST",
    headers: authorizationHeaders(options.platformToken),
  });
  if (!response.ok) throw await providerError(response);
  const payload = await response.json() as { jwt?: unknown };
  return requireToken(String(payload.jwt ?? ""), "database upload token");
}

export async function invalidateTursoDatabaseTokens(
  options: TursoPlatformUploadOptions,
): Promise<void> {
  const request = options.fetchImpl ?? fetch;
  const response = await request(platformUrl(options, "/auth/rotate"), {
    method: "POST",
    headers: authorizationHeaders(options.platformToken),
  });
  if (!response.ok) throw await providerError(response);
}
