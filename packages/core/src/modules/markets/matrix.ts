// The active presence matrix (MARKETS-DESIGN D4): every active market with
// its countries and subfolder presences, backup first. The storefront layout
// carries it (hreflang, the market selector), the gateway resolves a buyer's
// choice with it, and checkout resolves the order's market with it. Three
// small bounded statements that join any batch.
import type { Database } from "@scalius/database/client";
import { marketCountries, marketPresences, markets } from "@scalius/database/schema";
import type { MarketMatrix, PublicMarket } from "@scalius/shared/markets";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { deps } from "../../cache-deps";

export interface MarketMatrixRows {
    markets: ReadonlyArray<{ id: string; handle: string; name: string; status: string; isBackup: boolean | number }>;
    countries: ReadonlyArray<{ countryCode: string; marketId: string }>;
    presences: ReadonlyArray<{ marketId: string; kind: string; value: string; locale: string }>;
}

/** The three statements of the matrix, for a caller's batch; `marketMatrixFromRows` reads their results. */
export function planMarketMatrix(db: Database) {
    deps.anyMarket();
    return {
        statements: [
            db.select({
                id: markets.id,
                handle: markets.handle,
                name: markets.name,
                status: markets.status,
                isBackup: markets.isBackup,
            }).from(markets).orderBy(desc(markets.isBackup), asc(markets.name), asc(markets.id)),
            db.select({ countryCode: marketCountries.countryCode, marketId: marketCountries.marketId })
                .from(marketCountries)
                .orderBy(asc(marketCountries.countryCode)),
            db.select({
                marketId: marketPresences.marketId,
                kind: marketPresences.kind,
                value: marketPresences.value,
                locale: marketPresences.locale,
            }).from(marketPresences)
                .where(eq(marketPresences.kind, "subfolder"))
                .orderBy(asc(marketPresences.createdAt), asc(marketPresences.value)),
        ] as const,
        resolve(results: readonly unknown[], offset = 0): MarketMatrix {
            return marketMatrixFromRows({
                markets: results[offset] as MarketMatrixRows["markets"],
                countries: results[offset + 1] as MarketMatrixRows["countries"],
                presences: results[offset + 2] as MarketMatrixRows["presences"],
            });
        },
    };
}

/** Active markets only; a draft market's countries and presences resolve to nothing. */
export function marketMatrixFromRows(rows: MarketMatrixRows): MarketMatrix {
    const active = rows.markets.filter((market) => market.status === "active");
    const byId = new Map<string, PublicMarket>(active.map((market) => [market.id, {
        id: market.id,
        handle: market.handle,
        name: market.name,
        isBackup: Boolean(market.isBackup),
        countries: [],
        presences: [],
    }]));
    for (const country of rows.countries) byId.get(country.marketId)?.countries.push(country.countryCode);
    for (const presence of rows.presences) {
        const market = byId.get(presence.marketId);
        if (!market || presence.kind !== "subfolder") continue;
        // The root belongs to the backup market alone (the database enforces it too).
        if (presence.value === "" && !market.isBackup) continue;
        market.presences.push({ value: presence.value, locale: presence.locale });
    }
    for (const market of byId.values()) {
        market.countries.sort();
        // The root first: the backup market's own URL.
        market.presences.sort((left, right) => (left.value === "" ? -1 : right.value === "" ? 1 : 0));
    }
    const ordered = [...byId.values()];
    return { markets: [...ordered.filter((market) => market.isBackup), ...ordered.filter((market) => !market.isBackup)] };
}

export async function readMarketMatrix(db: Database): Promise<MarketMatrix> {
    const plan = planMarketMatrix(db);
    const results = await db.batch(plan.statements as never) as unknown[];
    return plan.resolve(results);
}

export interface PresenceMarket {
    id: string;
    handle: string;
    name: string;
    isBackup: boolean;
    presence: { value: string; locale: string };
}

/**
 * The active market a market-keyed public read renders for: the one holding
 * the subfolder `value`, or the backup market for the root (`''`). Null
 * when no active market holds that subfolder. Declares only `mk:<id>`: a
 * change of that market (or of the presence it holds) invalidates the read.
 */
export async function readPresenceMarket(db: Database, value: string): Promise<PresenceMarket | null> {
    const rows = await db.select({
        id: markets.id,
        handle: markets.handle,
        name: markets.name,
        isBackup: markets.isBackup,
        value: marketPresences.value,
        locale: marketPresences.locale,
    })
        .from(markets)
        .leftJoin(marketPresences, and(
            eq(marketPresences.marketId, markets.id),
            eq(marketPresences.kind, "subfolder"),
            eq(marketPresences.value, value),
        ))
        .where(and(
            eq(markets.status, "active"),
            value === "" ? eq(markets.isBackup, true) : sql`${marketPresences.value} IS NOT NULL`,
        ))
        .limit(1);
    const row = rows[0];
    if (!row) return null;
    deps.market(row.id);
    return {
        id: row.id,
        handle: row.handle,
        name: row.name,
        isBackup: Boolean(row.isBackup),
        presence: { value, locale: row.locale ?? "en" },
    };
}
