import { AppError, ValidationError } from "@scalius/core/errors";
import {
    NAVIGATION_RESOURCE_TYPES,
    parseNavigationQuery,
    type NavigationLabelMode,
    type NavigationResourceType,
} from "@scalius/shared/navigation-target";
import { parseNavigationHref } from "@scalius/shared/navigation-href";

export const NAVIGATION_MENU_ITEM_LIMIT = 10_000;
export const NAVIGATION_MENU_MAX_DEPTH = 3;
export const NAVIGATION_POSITION_GAP = 1_024;

export const NAVIGATION_PLACEMENT_REGISTRY = {
    "header.primary": {
        surface: "header",
        slot: "primary",
        repeatable: false,
        maxPositions: 1,
        maxDepth: 3,
        maxItems: 150,
    },
    "footer.column": {
        surface: "footer",
        slot: "column",
        repeatable: true,
        maxPositions: 4,
        maxDepth: 3,
        maxItems: 150,
    },
} as const;

export type NavigationPlacementKey = keyof typeof NAVIGATION_PLACEMENT_REGISTRY;

export interface NavigationPlacementDefinition {
    surface: string;
    slot: string;
    repeatable: boolean;
    maxPositions: number;
    maxDepth: number;
    maxItems: number;
}

export const NAVIGATION_SYSTEM_TARGETS = {
    home: "/",
    catalog: "/search",
    search: "/search",
    account: "/account",
    cart: "/cart",
    checkout: "/checkout",
    order_lookup: "/orders",
} as const;

export type NavigationSystemTarget = keyof typeof NAVIGATION_SYSTEM_TARGETS;
export type NavigationAuthorityTarget =
    | {
        type: "resource";
        resourceType: NavigationResourceType;
        resourceId: string;
        query?: string;
    }
    | { type: "system"; key: NavigationSystemTarget }
    | { type: "internal_path"; path: string }
    | { type: "external_url"; url: string }
    | { type: "label" };

export interface NavigationMenuItemInput {
    label: string;
    labelMode: NavigationLabelMode;
    target: NavigationAuthorityTarget;
    openInNewTab?: boolean;
    isEnabled?: boolean;
}

export interface NavigationMenuItemStorage {
    label: string;
    labelMode: NavigationLabelMode;
    targetType:
        | "label"
        | "system"
        | NavigationResourceType
        | "internal_path"
        | "external_url";
    targetId: string | null;
    targetValue: string | null;
    targetQuery: string | null;
    openInNewTab: boolean;
    isEnabled: boolean;
}

export function getNavigationPlacementDefinition(
    surface: string,
    slot: string,
): NavigationPlacementDefinition {
    const key = `${surface.trim()}.${slot.trim()}` as NavigationPlacementKey;
    const definition = NAVIGATION_PLACEMENT_REGISTRY[key];
    if (!definition) {
        throw new ValidationError("Choose a navigation placement supported by the current storefront theme.");
    }
    return definition;
}

export interface NavigationHierarchyRow {
    id: string;
    parentId: string | null;
    position: number;
}

export interface NavigationHierarchyNode<T extends NavigationHierarchyRow> {
    item: T;
    depth: number;
    children: NavigationHierarchyNode<T>[];
}

export class NavigationRevisionConflictError extends AppError {
    constructor(
        menuId: string,
        expectedRevision: number,
        currentRevision: number | null,
    ) {
        super(
            409,
            "NAVIGATION_REVISION_CONFLICT",
            "This menu changed while you were editing. Your draft is still in the browser; reload the latest menu before saving again.",
            { menuId, expectedRevision, currentRevision },
        );
        this.name = "NavigationRevisionConflictError";
    }
}

export class NavigationPlacementRevisionConflictError extends AppError {
    constructor(
        placementId: string,
        expectedRevision: number,
        currentRevision: number | null,
    ) {
        super(
            409,
            "NAVIGATION_PLACEMENT_REVISION_CONFLICT",
            "This menu placement changed while you were editing. Reload the latest placements and try again.",
            { placementId, expectedRevision, currentRevision },
        );
        this.name = "NavigationPlacementRevisionConflictError";
    }
}

export function normalizeNavigationMenuHandle(value: string): string {
    const normalized = value
        .normalize("NFKD")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
    if (!normalized || normalized.length > 80) {
        throw new ValidationError("Menu handle must contain letters or numbers and be 80 characters or fewer.");
    }
    return normalized;
}

export function normalizeNavigationMenuName(value: string): string {
    const name = value.trim();
    if (!name || name.length > 100) {
        throw new ValidationError("Menu name must be between 1 and 100 characters.");
    }
    return name;
}

function normalizeItemLabel(value: string): string {
    const label = value.trim();
    if (!label || label.length > 100) {
        throw new ValidationError("Menu item label must be between 1 and 100 characters.");
    }
    return label;
}

function normalizeResourceTarget(
    target: Extract<NavigationAuthorityTarget, { type: "resource" }>,
): Pick<NavigationMenuItemStorage, "targetType" | "targetId" | "targetValue" | "targetQuery"> {
    if (!NAVIGATION_RESOURCE_TYPES.includes(target.resourceType)) {
        throw new ValidationError("Choose a supported page, category, collection, or product target.");
    }
    const resourceId = target.resourceId.trim();
    if (!resourceId || resourceId.length > 200) {
        throw new ValidationError("Navigation resource identity is missing or too long.");
    }
    const query = parseNavigationQuery(target.query);
    if (!query.ok) throw new ValidationError(query.reason);
    return {
        targetType: target.resourceType,
        targetId: resourceId,
        targetValue: null,
        targetQuery: query.query ?? null,
    };
}

export function normalizeNavigationMenuItemInput(
    input: NavigationMenuItemInput,
): NavigationMenuItemStorage {
    const label = normalizeItemLabel(input.label);
    let target: Pick<
        NavigationMenuItemStorage,
        "targetType" | "targetId" | "targetValue" | "targetQuery"
    >;

    switch (input.target.type) {
        case "resource":
            target = normalizeResourceTarget(input.target);
            break;
        case "system": {
            if (!(input.target.key in NAVIGATION_SYSTEM_TARGETS)) {
                throw new ValidationError("Choose a supported storefront destination.");
            }
            target = {
                targetType: "system",
                targetId: null,
                targetValue: input.target.key,
                targetQuery: null,
            };
            break;
        }
        case "internal_path": {
            const parsed = parseNavigationHref(input.target.path);
            if (!parsed.ok || parsed.kind !== "internal" || !parsed.href) {
                throw new ValidationError(
                    parsed.ok ? "Enter a same-store path." : parsed.reason,
                );
            }
            target = {
                targetType: "internal_path",
                targetId: null,
                targetValue: parsed.href,
                targetQuery: null,
            };
            break;
        }
        case "external_url": {
            const parsed = parseNavigationHref(input.target.url);
            if (!parsed.ok || parsed.kind !== "external" || !parsed.href) {
                throw new ValidationError(
                    parsed.ok ? "Enter a credential-free HTTPS URL." : parsed.reason,
                );
            }
            target = {
                targetType: "external_url",
                targetId: null,
                targetValue: parsed.href,
                targetQuery: null,
            };
            break;
        }
        case "label":
            target = {
                targetType: "label",
                targetId: null,
                targetValue: null,
                targetQuery: null,
            };
            break;
    }

    if (input.labelMode === "resource" && input.target.type !== "resource") {
        throw new ValidationError("Only resource links can follow the resource title automatically.");
    }

    return {
        label,
        labelMode: input.labelMode,
        ...target,
        openInNewTab: input.openInNewTab === true,
        isEnabled: input.isEnabled !== false,
    };
}

export function buildNavigationHierarchy<T extends NavigationHierarchyRow>(
    rows: readonly T[],
): NavigationHierarchyNode<T>[] {
    if (rows.length > NAVIGATION_MENU_ITEM_LIMIT) {
        throw new ValidationError(`A menu can contain at most ${NAVIGATION_MENU_ITEM_LIMIT} items.`);
    }

    const byId = new Map<string, NavigationHierarchyNode<T>>();
    for (const row of rows) {
        if (byId.has(row.id)) throw new ValidationError("Menu item identities must be unique.");
        byId.set(row.id, { item: row, depth: 1, children: [] });
    }

    const roots: NavigationHierarchyNode<T>[] = [];
    for (const node of byId.values()) {
        if (!node.item.parentId) {
            roots.push(node);
            continue;
        }
        const parent = byId.get(node.item.parentId);
        if (!parent) throw new ValidationError(`Menu item ${node.item.id} has no valid parent.`);
        if (parent === node) throw new ValidationError("A menu item cannot contain itself.");
        parent.children.push(node);
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (node: NavigationHierarchyNode<T>, depth: number): void => {
        if (visiting.has(node.item.id)) throw new ValidationError("Menu items cannot form a cycle.");
        if (depth > NAVIGATION_MENU_MAX_DEPTH) {
            throw new ValidationError(`Menus support at most ${NAVIGATION_MENU_MAX_DEPTH} levels.`);
        }
        if (visited.has(node.item.id)) return;
        visiting.add(node.item.id);
        node.depth = depth;
        node.children.sort(compareNavigationHierarchyRows);
        for (const child of node.children) visit(child, depth + 1);
        visiting.delete(node.item.id);
        visited.add(node.item.id);
    };

    roots.sort(compareNavigationHierarchyRows);
    for (const root of roots) visit(root, 1);
    if (visited.size !== rows.length) {
        throw new ValidationError("Every menu item must be reachable from a top-level item.");
    }
    return roots;
}

function compareNavigationHierarchyRows<T extends NavigationHierarchyRow>(
    left: NavigationHierarchyNode<T>,
    right: NavigationHierarchyNode<T>,
): number {
    return left.item.position - right.item.position || left.item.id.localeCompare(right.item.id);
}

export function sparsePositionBetween(
    previous: number | null,
    next: number | null,
): number | null {
    if (previous == null && next == null) return NAVIGATION_POSITION_GAP;
    if (previous == null) {
        const candidate = next! - NAVIGATION_POSITION_GAP;
        return Number.isSafeInteger(candidate) ? candidate : null;
    }
    if (next == null) {
        const candidate = previous + NAVIGATION_POSITION_GAP;
        return Number.isSafeInteger(candidate) ? candidate : null;
    }
    if (next <= previous + 1) return null;
    const candidate = previous + Math.floor((next - previous) / 2);
    return Number.isSafeInteger(candidate) ? candidate : null;
}

export async function checksumNavigationPublication(
    rows: readonly (NavigationHierarchyRow & NavigationMenuItemStorage)[],
): Promise<string> {
    const hierarchy = buildNavigationHierarchy(rows);
    const ordered: Array<Record<string, unknown>> = [];
    const collect = (
        nodes: readonly NavigationHierarchyNode<NavigationHierarchyRow & NavigationMenuItemStorage>[],
    ): void => {
        for (const node of nodes) {
            const item = node.item;
            ordered.push({
                id: item.id,
                parentId: item.parentId,
                position: item.position,
                label: item.label,
                labelMode: item.labelMode,
                targetType: item.targetType,
                targetId: item.targetId,
                targetValue: item.targetValue,
                targetQuery: item.targetQuery,
                openInNewTab: item.openInNewTab,
                isEnabled: item.isEnabled,
            });
            collect(node.children);
        }
    };
    collect(hierarchy);

    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(ordered)),
    );
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}
