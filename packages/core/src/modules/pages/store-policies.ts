// src/modules/pages/store-policies.ts
// Settings -> Policies: which of the store's own pages is its refund, privacy,
// terms, shipping and contact policy. Buyers see only published pages.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { safeBatch, type Database } from "@scalius/database/client";
import { pages } from "@scalius/database/schema";
import { ValidationError } from "../../errors";
import { planPublicPagesByIdDeclaration, publicPageVisibilityCondition } from "./pages.service";
import { policiesDocument, STORE_POLICY_KINDS, type StorePolicies, type StorePolicyKind } from "../settings";
import { translateRows, translationColumns, type TranslationScope } from "../translations";

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

type BatchItem = Parameters<typeof safeBatch>[1][number];

/**
 * The linked policies buyers can open right now, as statements for the
 * caller's batch (none when no policy links a page) and how to read them
 * from its results, in policy order.
 */
export function planPublicStorePolicies(db: Database, policies: StorePolicies, translation: TranslationScope | null = null) {
  const ids = linkedPageIds(policies);
  const declaration = planPublicPagesByIdDeclaration(db, ids);
  const pagesRead = ids.length > 0
    ? db
      .select({ id: pages.id, title: pages.title, slug: pages.slug, ...translationColumns(translation, "page", pages.id) })
      .from(pages)
      .where(and(inArray(pages.id, ids), publicPageVisibilityCondition("page")))
    : null;
  type PolicyPageRow = Awaited<NonNullable<typeof pagesRead>>[number];
  return {
    statements: [...declaration.statements, ...(pagesRead ? [pagesRead] : [])] as BatchItem[],
    resolve(results: readonly unknown[], offset: number): PublicStorePolicy[] {
      if (!pagesRead) return [];
      declaration.declare(results, offset);
      // A presence's policy titles and handles in its language (MARKETS-DESIGN D9).
      const rows = translateRows(translation, "page", results[offset + declaration.statements.length] as PolicyPageRow[], { title: "title" });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return STORE_POLICY_KINDS.flatMap((kind) => {
        const page = policies[kind] ? byId.get(policies[kind]!) : undefined;
        return page ? [{ kind, title: page.title, path: `/${page.slug}` }] : [];
      });
    },
  };
}

/** The linked policies buyers can open right now, in policy order (one batch). */
export async function resolvePublicStorePolicies(
  db: Database,
  policies: StorePolicies,
): Promise<PublicStorePolicy[]> {
  const plan = planPublicStorePolicies(db, policies);
  return plan.resolve(plan.statements.length > 0 ? await safeBatch(db, plan.statements) : [], 0);
}
