// Name and host patterns of the plugin manifest, apart from its schema so the
// storefront-components contract can use them without a cycle. Part of the
// versioned plugin API.

/** Route, page, card, action, cron, collection and section names. */
export const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
/**
 * Exact hosts or one leading wildcard label (`*.example.com`); never IP
 * literals or localhost. An exact host may name one non-default https port
 * (`sandbox.example.com:10061`, a provider sandbox's): only that port is
 * then reachable on it.
 */
export const PLUGIN_HOST_PATTERN = /^(?:(?:\*\.)?(?=[a-z0-9.-]{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|(?=[a-z0-9.-]{1,253}:)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}:(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))$/;

/**
 * Whether `allowedHosts` lets a request reach `hostname` on `port` ("" for
 * the default https port). A wildcard matches subdomains only, and only on
 * the default port; a non-default port needs its exact `host:port` entry.
 */
export function isPluginHostAllowed(hostname: string, allowedHosts: readonly string[], port = ""): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (port !== "" && port !== "443") return allowedHosts.some((pattern) => pattern.toLowerCase() === `${host}:${port}`);
  return allowedHosts.some((pattern) => {
    const allowed = pattern.toLowerCase();
    if (allowed.includes(":")) return false;
    if (allowed.startsWith("*.")) return host.endsWith(allowed.slice(1)) && host.length > allowed.length - 1;
    return host === allowed;
  });
}

