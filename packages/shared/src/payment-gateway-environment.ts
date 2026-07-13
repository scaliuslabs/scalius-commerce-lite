export type StripeCredentialEnvironment = "test" | "live" | "mixed" | "unknown";

function getStripeKeyEnvironment(
  value: unknown,
  keyType: "secret" | "publishable",
): "test" | "live" | "unknown" {
  if (typeof value !== "string") return "unknown";

  const normalized = value.trim().toLowerCase();
  const prefixes = keyType === "secret"
    ? { test: ["sk_test", "rk_test"], live: ["sk_live", "rk_live"] }
    : { test: ["pk_test"], live: ["pk_live"] };

  if (prefixes.test.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}_`))) {
    return "test";
  }
  if (prefixes.live.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}_`))) {
    return "live";
  }
  return "unknown";
}

export function getStripeCredentialEnvironment(
  settings: { secretKey?: unknown; publishableKey?: unknown } | null | undefined,
): StripeCredentialEnvironment {
  const secretEnvironment = getStripeKeyEnvironment(settings?.secretKey, "secret");
  const publishableEnvironment = getStripeKeyEnvironment(settings?.publishableKey, "publishable");

  if (
    secretEnvironment !== "unknown"
    && publishableEnvironment !== "unknown"
    && secretEnvironment !== publishableEnvironment
  ) {
    return "mixed";
  }

  return secretEnvironment !== "unknown" ? secretEnvironment : publishableEnvironment;
}
