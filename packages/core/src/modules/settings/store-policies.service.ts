// src/modules/settings/store-policies.service.ts
// Settings -> Policies: which of the store's own pages is its refund, privacy,
// terms, shipping and contact policy. Buyers see only published pages.

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { pages } from "@scalius/database/schema";
import { ValidationError } from "../../errors";
import { declarePublicPagesById, publicPageVisibilityCondition } from "../pages/pages.service";
import {
  policiesDocument,
  STORE_POLICY_KINDS,
  type StorePolicies,
  type StorePolicyKind,
} from "./documents";

export { STORE_POLICY_KINDS, type StorePolicies, type StorePolicyKind } from "./documents";

/** A policy a buyer can open: its page title and same-store path. */
export interface PublicStorePolicy {
  kind: StorePolicyKind;
  title: string;
  path: string;
}

const linkedPageIds = (policies: Partial<StorePolicies>) =>
  [...new Set(STORE_POLICY_KINDS.flatMap((kind) => (policies[kind] ? [policies[kind]!] : [])))];

export async function getStorePolicies(db: Database): Promise<StorePolicies & { revision: number }> {
  const { value, revision } = await policiesDocument.readDetailed(db);
  return { ...value, revision };
}

/** Links only the store's own content pages (drafts included, trash not). */
export async function saveStorePolicies(
  db: Database,
  patch: Partial<StorePolicies>,
  options: { expectedRevision: number },
): Promise<StorePolicies & { revision: number }> {
  const ids = linkedPageIds(patch);
  if (ids.length > 0) {
    const found = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(inArray(pages.id, ids), eq(pages.contentType, "page"), isNull(pages.deletedAt)));
    const known = new Set(found.map((row) => row.id));
    const message = "Choose one of your store's pages.";
    const issues = STORE_POLICY_KINDS
      .filter((kind) => patch[kind] && !known.has(patch[kind]!))
      .map((kind) => ({ path: [kind], message }));
    if (issues.length > 0) throw new ValidationError(message, { issues });
  }
  const { value, revision } = await policiesDocument.write(db, patch, {}, {
    expectedRevision: options.expectedRevision,
  });
  return { ...value, revision };
}

/** The linked policies buyers can open right now, in policy order. */
export async function resolvePublicStorePolicies(
  db: Database,
  policies: StorePolicies,
): Promise<PublicStorePolicy[]> {
  const ids = linkedPageIds(policies);
  if (ids.length === 0) return [];
  await declarePublicPagesById(db, ids);
  const rows = await db
    .select({ id: pages.id, title: pages.title, slug: pages.slug })
    .from(pages)
    .where(and(inArray(pages.id, ids), publicPageVisibilityCondition("page")));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return STORE_POLICY_KINDS.flatMap((kind) => {
    const page = policies[kind] ? byId.get(policies[kind]!) : undefined;
    return page ? [{ kind, title: page.title, path: `/${page.slug}` }] : [];
  });
}
