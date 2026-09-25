// src/modules/attributes/attribute-groups.ts
// Spec-table groups ("Display", "Processor"): the product page groups its
// specification table by them. Names are unique among live groups (the
// database has a partial unique index on lower(name)); trashing a group
// ungroups its attributes in the same batch.
import { attributeGroups, productAttributes } from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";

import { isUniqueViolation } from "./attribute-definition";
import { jsonIdSet } from "./projection-refresh";
import type { CreateAttributeGroupInput, UpdateAttributeGroupInput } from "./attributes.validation";

/** Live groups a store may have; the list reads them all at once. */
export const MAX_ATTRIBUTE_GROUPS = 500;
const GROUP_UNIQUE_PATTERN = /attribute_groups(?:_live_name_unique|\.name)/i;

const groupColumns = {
    id: attributeGroups.id,
    name: attributeGroups.name,
    sortOrder: attributeGroups.sortOrder,
    createdAt: attributeGroups.createdAt,
    updatedAt: attributeGroups.updatedAt,
};

async function assertGroupNameFree(db: Database, name: string, excludeId?: string): Promise<void> {
    const clash = await db
        .select({ id: attributeGroups.id })
        .from(attributeGroups)
        .where(and(
            isNull(attributeGroups.deletedAt),
            sql`lower(${attributeGroups.name}) = lower(${name})`,
            excludeId ? sql`${attributeGroups.id} <> ${excludeId}` : undefined,
        ))
        .get();
    if (clash) throw new ConflictError(`A group named "${name}" already exists.`);
}

function rethrowGroupConflict(error: unknown, name: string | undefined): never {
    if (name !== undefined && isUniqueViolation(error, GROUP_UNIQUE_PATTERN)) {
        throw new ConflictError(`A group named "${name}" already exists.`);
    }
    throw error;
}

/** Live groups by sort order then name, each with its live attribute count. */
export async function listAttributeGroups(db: Database) {
    const groups = await db
        .select({
            ...groupColumns,
            // Aliased and table-qualified: a single-table select renders its
            // columns unqualified, which the subquery would resolve to itself.
            attributeCount: sql<number>`(
                SELECT count(*) FROM ${productAttributes} AS grouped
                WHERE grouped.group_id = ${attributeGroups}.id
                  AND grouped.deleted_at IS NULL
            )`.as("attribute_count"),
        })
        .from(attributeGroups)
        .where(isNull(attributeGroups.deletedAt))
        .orderBy(asc(attributeGroups.sortOrder), sql`lower(${attributeGroups.name})`, asc(attributeGroups.id))
        .limit(MAX_ATTRIBUTE_GROUPS)
        .all();
    return { groups: groups.map((group) => ({ ...group, attributeCount: Number(group.attributeCount) })) };
}

export async function createAttributeGroup(db: Database, input: CreateAttributeGroupInput) {
    const name = input.name.trim();
    await assertGroupNameFree(db, name);
    const live = await db
        .select({ total: sql<number>`count(*)` })
        .from(attributeGroups)
        .where(isNull(attributeGroups.deletedAt))
        .get();
    if (Number(live?.total ?? 0) >= MAX_ATTRIBUTE_GROUPS) {
        throw new ValidationError(`A store can have at most ${MAX_ATTRIBUTE_GROUPS} attribute groups.`);
    }
    try {
        const [group] = await db.insert(attributeGroups)
            .values({
                id: `atg_${nanoid()}`,
                name,
                sortOrder: input.sortOrder ?? sql`(SELECT COALESCE(MAX(existing.sort_order) + 1, 0) FROM ${attributeGroups} AS existing WHERE existing.deleted_at IS NULL)`,
            })
            .returning(groupColumns);
        return { group: { ...group!, attributeCount: 0 } };
    } catch (error) {
        rethrowGroupConflict(error, name);
    }
}

export async function updateAttributeGroup(db: Database, groupId: string, input: UpdateAttributeGroupInput) {
    const name = input.name?.trim();
    if (name !== undefined) await assertGroupNameFree(db, name, groupId);
    try {
        const [group] = await db.update(attributeGroups)
            .set({
                ...(name !== undefined ? { name } : {}),
                ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
                updatedAt: sql`unixepoch()`,
            })
            .where(and(eq(attributeGroups.id, groupId), isNull(attributeGroups.deletedAt)))
            .returning(groupColumns);
        if (!group) throw new NotFoundError("Attribute group not found");
        return { group };
    } catch (error) {
        rethrowGroupConflict(error, name);
    }
}

/** Soft-deletes the group; its attributes become ungrouped in the same batch. */
export async function trashAttributeGroup(db: Database, groupId: string) {
    const group = await db
        .select({ id: attributeGroups.id })
        .from(attributeGroups)
        .where(and(eq(attributeGroups.id, groupId), isNull(attributeGroups.deletedAt)))
        .get();
    if (!group) throw new NotFoundError("Attribute group not found");
    await safeBatch(db, [
        db.update(productAttributes)
            .set({ groupId: null, updatedAt: sql`unixepoch()` })
            .where(eq(productAttributes.groupId, groupId)),
        db.update(attributeGroups)
            .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
            .where(and(eq(attributeGroups.id, groupId), isNull(attributeGroups.deletedAt))),
    ] as never);
}

/** Sets the sort order of up to 90 live groups in one statement. */
export async function reorderAttributeGroups(
    db: Database,
    items: ReadonlyArray<{ groupId: string; sortOrder: number }>,
) {
    const ids = [...new Set(items.map((item) => item.groupId))];
    if (ids.length !== items.length) throw new ValidationError("Each group can appear only once.");
    const live = await db
        .select({ id: attributeGroups.id })
        .from(attributeGroups)
        .where(and(isNull(attributeGroups.deletedAt), sql`${attributeGroups.id} IN ${jsonIdSet(ids)}`))
        .all();
    if (live.length !== ids.length) throw new NotFoundError("One or more groups no longer exist. Refresh and try again.");
    const payload = JSON.stringify(items.map((item) => ({ i: item.groupId, s: item.sortOrder })));
    await db.update(attributeGroups)
        .set({
            sortOrder: sql`(SELECT CAST(json_extract(entry.value, '$.s') AS INTEGER) FROM json_each(${payload}) AS entry WHERE CAST(json_extract(entry.value, '$.i') AS TEXT) = ${attributeGroups.id})`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            isNull(attributeGroups.deletedAt),
            sql`${attributeGroups.id} IN (SELECT CAST(json_extract(entry.value, '$.i') AS TEXT) FROM json_each(${payload}) AS entry)`,
        ))
        .run();
    return listAttributeGroups(db);
}

/** A group an attribute may join: it exists and is not in trash. */
export async function assertLiveAttributeGroup(db: Database, groupId: string | null | undefined): Promise<void> {
    if (!groupId) return;
    const group = await db
        .select({ id: attributeGroups.id })
        .from(attributeGroups)
        .where(and(eq(attributeGroups.id, groupId), isNull(attributeGroups.deletedAt)))
        .get();
    if (!group) throw new ValidationError("That attribute group is unavailable or in trash.", { field: "groupId" });
}
