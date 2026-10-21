// The storefront's render incidents (`@scalius/shared/plugins/storefront-incidents`):
// a page drawn without an app's section, block or skin becomes one line in
// that app's log, in plain words, so the merchant sees it on the app's page
// and in the theme editor, and the developer in the app's Activity. Internal:
// `POST /api/v1/storefront/app-incidents`, authenticated with the storefront's
// frontier key and answered at the Worker entry like the frontier endpoints.
// The same line is written at most once per ten minutes per app, so a
// broken skin on a busy store cannot flood its log.

import type { Database } from "@scalius/database/client";
import {
  getPluginInstallation,
  hasRecentPluginLogLine,
  newestPluginLogLines,
  writePluginLogs,
  type PluginLogInput,
} from "@scalius/core/modules/plugins";
import { STOREFRONT_COMPONENT_LIMITS } from "@scalius/shared/plugins/storefront-protocol";
import {
  STOREFRONT_INCIDENT_REASONS,
  STOREFRONT_INCIDENT_SOURCE,
  storefrontIncidentReportSchema,
  storefrontIncidentSource,
  type StorefrontIncident,
  type StorefrontIncidentReason,
} from "@scalius/shared/plugins/storefront-incidents";
import { hasFrontierKey } from "../cache-frontier";

/** The same incident line is written again only after this long. */
export const STOREFRONT_INCIDENT_REPEAT_MS = 10 * 60 * 1000;
/** How far back the dashboard looks for an app's storefront problem. */
export const STOREFRONT_INCIDENT_RECENT_MS = 24 * 60 * 60 * 1000;

const SKIN_UNIT_WORDS: Record<string, string> = {
  header: "header",
  footer: "footer",
  product_card: "product card",
  product_main: "product page",
  listing_main: "product listing",
};

function partWords(incident: StorefrontIncident): string {
  if (incident.kind === "section") return `the section "${incident.type}"`;
  if (incident.kind === "component") return `the block "${incident.type}"`;
  const target = incident.target ?? "";
  const unit = target.startsWith("section:") ? `"${target.slice(8)}" section` : SKIN_UNIT_WORDS[target] ?? target;
  return `the ${unit} design "${incident.type}"`;
}

function reasonWords(incident: StorefrontIncident): string {
  const detail = incident.detail?.trim().replace(/\.$/, "");
  switch (incident.reason) {
    case "unavailable": return detail ? `the store can't run this version of the app here (${detail})` : "the store can't run this version of the app here";
    case "late": return `it took longer than ${STOREFRONT_COMPONENT_LIMITS.renderWallMs} ms to answer`;
    case "error": return detail ? `its code failed: ${detail}` : "its code failed";
    case "refused": return detail ? `what it drew broke the storefront's limits (${detail})` : "what it drew broke the storefront's limits";
    case "missing": return "it answered without it";
  }
}

/** The app log line of one incident: what, why and what the store drew instead. */
export function storefrontIncidentLine(incident: StorefrontIncident): PluginLogInput {
  const instead = incident.kind === "skin" ? "It showed your theme's own design instead." : "It left it out of the page.";
  return {
    level: incident.reason === "late" || incident.reason === "unavailable" ? "warn" : "error",
    source: storefrontIncidentSource(incident),
    message: `Your store couldn't show ${partWords(incident)}: ${reasonWords(incident)}. ${instead}`.slice(0, 500),
    fields: {
      kind: incident.kind,
      type: incident.type,
      ...(incident.target ? { target: incident.target } : {}),
      reason: incident.reason,
      release: incident.release.slice(0, 12),
    },
  };
}

const reply = (status: number) => new Response(null, { status, headers: { "Cache-Control": "private, no-store" } });

/** Writes each reported incident of an installed app once per repeat window. */
export async function recordStorefrontIncidents(db: Database, incidents: readonly StorefrontIncident[], now = Date.now()): Promise<number> {
  let written = 0;
  for (const incident of incidents) {
    if (!(await getPluginInstallation(db, incident.pluginId))) continue;
    const line = storefrontIncidentLine(incident);
    if (await hasRecentPluginLogLine(db, incident.pluginId, line, now - STOREFRONT_INCIDENT_REPEAT_MS)) continue;
    written += await writePluginLogs(db, incident.pluginId, [line]);
  }
  return written;
}

export async function serveStorefrontIncidents(
  request: Request,
  env: { SCALIUS_SECRET?: unknown },
  db: () => Database,
): Promise<Response> {
  if (!(await hasFrontierKey(request, env))) return reply(404);
  const parsed = storefrontIncidentReportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return reply(400);
  await recordStorefrontIncidents(db(), parsed.data.incidents);
  return reply(204);
}

/** One app's newest storefront problem in the last day, as the dashboard shows it. */
export interface StorefrontProblem {
  pluginId: string;
  message: string;
  kind: string | null;
  type: string | null;
  target: string | null;
  reason: StorefrontIncidentReason | null;
  /** Epoch seconds. */
  at: number;
}

/** The newest storefront problem of each of these apps, written in the last day. */
export async function recentStorefrontProblems(db: Database, pluginIds: readonly string[], now = Date.now()): Promise<StorefrontProblem[]> {
  const lines = await newestPluginLogLines(db, pluginIds, STOREFRONT_INCIDENT_SOURCE, now - STOREFRONT_INCIDENT_RECENT_MS);
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return lines.map((line) => ({
    pluginId: line.pluginId,
    message: line.message,
    kind: text(line.fields.kind),
    type: text(line.fields.type),
    target: text(line.fields.target),
    reason: (STOREFRONT_INCIDENT_REASONS as readonly unknown[]).includes(line.fields.reason) ? line.fields.reason as StorefrontIncidentReason : null,
    at: line.createdAt,
  }));
}
