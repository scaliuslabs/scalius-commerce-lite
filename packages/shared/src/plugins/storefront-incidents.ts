// A storefront render incident: an app's section, block or skin the store
// asked for and drew without (docs/STOREFRONT-COMPONENTS.md). The storefront
// reports it to the API over its service binding, authenticated with its
// frontier key (internal, not part of the public contract); the API writes
// one line in the app's log (source `storefront:<kind>:<type>`), which the
// app's Activity, the app's overview and the theme editor show. An incident
// names the part and why, never the page, the buyer or the data drawn.

import { z } from "zod";

/** `POST`: the storefront's incident reports (internal; frontier-key authenticated). */
export const STOREFRONT_INCIDENTS_PATH = "/api/v1/storefront/app-incidents";

/** Incidents one report may carry; the rest wait for the next page. */
export const STOREFRONT_INCIDENTS_MAX = 20;

/** The log source prefix of storefront incidents. */
export const STOREFRONT_INCIDENT_SOURCE = "storefront:";

/**
 * Why the store drew without the part:
 * - `unavailable`: this Worker cannot run the app's release (no Worker Loader, a release not compiled in, an unreadable module);
 * - `late`: no answer within the render wall time;
 * - `error`: the app's code threw or answered an error;
 * - `refused`: its markup broke the component profile's bounds;
 * - `missing`: its reply left the part out.
 */
export const STOREFRONT_INCIDENT_REASONS = ["unavailable", "late", "error", "refused", "missing"] as const;
export type StorefrontIncidentReason = (typeof STOREFRONT_INCIDENT_REASONS)[number];

const partId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_.:-]*$/);

export const storefrontIncidentSchema = z.object({
  pluginId: z.string().min(3).max(100),
  release: z.string().regex(/^[0-9a-f]{64}$/),
  /** A section the app draws, a component (block) at a slot, or a skin of a unit or core section. */
  kind: z.enum(["section", "component", "skin"]),
  /** The section type, the component type, or the skin id. */
  type: partId,
  /** A component's slot or a skin's target (`product_card`, `section:usp_strip`). */
  target: partId.optional(),
  reason: z.enum(STOREFRONT_INCIDENT_REASONS),
  /** The app's own error text (`error`) or the bound it broke (`refused`), cut short; masked again when written. */
  detail: z.string().max(200).optional(),
}).strict();
export type StorefrontIncident = z.infer<typeof storefrontIncidentSchema>;

export const storefrontIncidentReportSchema = z.object({
  incidents: z.array(storefrontIncidentSchema).min(1).max(STOREFRONT_INCIDENTS_MAX),
}).strict();

/** The log source of one incident's part (at most 80 characters). */
export function storefrontIncidentSource(incident: Pick<StorefrontIncident, "kind" | "type">): string {
  return `${STOREFRONT_INCIDENT_SOURCE}${incident.kind}:${incident.type}`.slice(0, 80);
}
