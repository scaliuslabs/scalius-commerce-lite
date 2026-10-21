// The identifier rule and host patterns of the plugin manifest, apart from its
// schema so the storefront-components contract can use them without a cycle.
// Part of the versioned plugin API.
//
// One identifier rule (packages/plugin-sdk/docs/apps.md, "Names"):
//   - every manifest name and data key is snake_case (`PLUGIN_KEY_PATTERN`):
//     object types and fields, settings, custom fields, timeline kinds,
//     checkout attributes, skin, section and block types, cron jobs, cards,
//     actions, widgets, tabs, list columns, settings groups, templates;
//   - a name that becomes a URL path segment (`PLUGIN_URL_NAME_PATTERN`) may
//     also be kebab-case: route names, page ids, island names, feature ids,
//     provider ids and sales channel ids.

import { z } from "zod";

/** A manifest name or data key: snake_case, at most 48 characters. */
export const PLUGIN_KEY_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
export const PLUGIN_KEY_RULE = "Use snake_case: a lowercase letter, then at most 47 lowercase letters, digits or underscores.";

/** A name that is also a URL path segment: snake_case or kebab-case, at most 48 characters. */
export const PLUGIN_URL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
export const PLUGIN_URL_NAME_RULE = "Use snake_case or kebab-case (this name is part of a URL): a lowercase letter, then at most 47 lowercase letters, digits, underscores or hyphens.";

/** An object or custom field key: snake_case, at most 64 characters. */
export const PLUGIN_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const PLUGIN_FIELD_KEY_RULE = "Use snake_case: a lowercase letter, then at most 63 lowercase letters, digits or underscores.";

/** An object type: snake_case, 2 to 48 characters (the store's `object_types.type` check). */
export const PLUGIN_OBJECT_TYPE_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;
export const PLUGIN_OBJECT_TYPE_RULE = "Use snake_case: a lowercase letter, then 1 to 47 lowercase letters, digits or underscores.";

/** A manifest name or data key (`PLUGIN_KEY_PATTERN`). */
export const pluginKeySchema = () => z.string().regex(PLUGIN_KEY_PATTERN, PLUGIN_KEY_RULE);
/** A name that is also a URL path segment (`PLUGIN_URL_NAME_PATTERN`). */
export const pluginUrlNameSchema = () => z.string().regex(PLUGIN_URL_NAME_PATTERN, PLUGIN_URL_NAME_RULE);
/** An object or custom field key (`PLUGIN_FIELD_KEY_PATTERN`). */
export const pluginFieldKeySchema = () => z.string().regex(PLUGIN_FIELD_KEY_PATTERN, PLUGIN_FIELD_KEY_RULE);

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
