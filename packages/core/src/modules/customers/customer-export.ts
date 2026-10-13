// Customer CSV export (Customers & marketing): the customers of a list
// filter, a segment or the subscriber view, walked in id order a page at a
// time (keyset, no offsets), with order facts, tags and the consent status of
// every channel. Spreadsheet-safe cells; bounded by rows and bytes.

import type { Database } from "@scalius/database/client";
import { customerAddresses, customerMarketingConsents, customerOrderStats, customers, orders } from "@scalius/database/schema";
import { MARKETING_CHANNELS, type MarketingChannel } from "@scalius/shared/customer-marketing";
import { fromMinor } from "@scalius/shared/money";
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { spreadsheetSafeCsvCell } from "@scalius/shared/spreadsheet-csv";
import { customerKind } from "./customer-identity";
import { currentMarketingContactSql } from "./customer-segments";
import { listTagsForCustomers } from "./customer-tags";
import { customerListFilterSql, type CustomerListFilters } from "./customers.service";

export const CUSTOMER_EXPORT_MAX_ROWS = 10_000;
export const CUSTOMER_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
const PAGE = 200;

export const CUSTOMER_CSV_HEADERS = [
    "Customer ID",
    "Name",
    "Phone",
    "Email",
    "Type",
    "City",
    "Zone",
    "Orders",
    "Amount spent",
    "First order",
    "Last order",
    "Tags",
    "Email marketing",
    "SMS marketing",
    "WhatsApp marketing",
    "Customer since",
    "Country",
    "Push marketing",
] as const;

/** City, zone and country come from the default address (Bangladesh: city and thana; elsewhere: locality and region). */
const defaultAddress = alias(customerAddresses, "export_default_address");

function consentStatusSql(channel: MarketingChannel): SQL {
    return sql<string>`COALESCE((SELECT CASE WHEN ${customerMarketingConsents.contact} = ${currentMarketingContactSql(channel)} THEN ${customerMarketingConsents.state} ELSE 'not_subscribed' END
        FROM ${customerMarketingConsents} WHERE ${customerMarketingConsents.customerId} = ${customers.id} AND ${customerMarketingConsents.channel} = ${channel}), 'not_subscribed')`;
}

const isoDate = (seconds: unknown) => (seconds ? new Date(Number(seconds) * 1000).toISOString() : "");

export interface CustomerCsvExport {
    body: string;
    byteLength: number;
    rowCount: number;
    /** Stopped at the row or byte cap before the end. */
    limited: boolean;
}

/** The CSV of live customers matching the filters (or exactly these ids). */
export async function buildCustomerCsvExport(
    db: Database,
    input: { filters?: CustomerListFilters; ids?: readonly string[]; maxRows?: number },
): Promise<CustomerCsvExport> {
    const maxRows = Math.min(Math.max(input.maxRows ?? CUSTOMER_EXPORT_MAX_ROWS, 1), CUSTOMER_EXPORT_MAX_ROWS);
    const encoder = new TextEncoder();
    const chunks: string[] = [`\uFEFF${CUSTOMER_CSV_HEADERS.map(spreadsheetSafeCsvCell).join(",")}`];
    let byteLength = encoder.encode(chunks[0]!).byteLength;
    let rowCount = 0;
    let limited = false;
    let afterId: string | null = null;
    const ids = input.ids ? [...new Set(input.ids)].slice(0, 100) : null;

    while (!limited) {
        const conditions: (SQL | undefined)[] = [
            isNull(customers.deletedAt),
            ...customerListFilterSql(input.filters),
            ids ? inArray(customers.id, ids) : undefined,
            afterId ? sql`${customers.id} > ${afterId}` : undefined,
        ];
        const page = await db.select({
            id: customers.id,
            name: customers.name,
            phone: customers.phone,
            email: customers.email,
            accountClaimedAt: customers.accountClaimedAt,
            origin: customers.origin,
            cityName: sql<string | null>`COALESCE(${defaultAddress.cityName}, ${defaultAddress.locality})`,
            zoneName: sql<string | null>`COALESCE(${defaultAddress.zoneName}, ${defaultAddress.adminArea})`,
            countryCode: defaultAddress.countryCode,
            ordersCount: sql<number>`COALESCE(${customerOrderStats.ordersCount}, 0)`,
            totalSpentMinor: sql<number>`COALESCE(${customerOrderStats.totalSpentMinor}, 0)`,
            decimalPlaces: sql<number>`COALESCE((SELECT ${orders.currencyDecimalPlaces} FROM ${orders} WHERE ${orders.customerId} = ${customers.id} LIMIT 1), 2)`,
            firstOrderAt: customerOrderStats.firstOrderAt,
            lastOrderAt: customerOrderStats.lastOrderAt,
            createdAt: sql<number>`CAST(${customers.createdAt} AS INTEGER)`,
            email_status: consentStatusSql("email"),
            sms_status: consentStatusSql("sms"),
            whatsapp_status: consentStatusSql("whatsapp"),
            push_status: consentStatusSql("push"),
        })
            .from(customers)
            .leftJoin(customerOrderStats, eq(customerOrderStats.customerId, customers.id))
            .leftJoin(defaultAddress, and(eq(defaultAddress.customerId, customers.id), eq(defaultAddress.isDefault, true)))
            .where(and(...conditions))
            .orderBy(asc(customers.id))
            .limit(Math.min(PAGE, maxRows - rowCount + 1));
        if (page.length === 0) break;
        const tags = await listTagsForCustomers(db, page.map((row) => row.id));
        for (const row of page) {
            if (rowCount >= maxRows) {
                limited = true;
                break;
            }
            const statuses = Object.fromEntries(MARKETING_CHANNELS.map((channel) => [channel, row[`${channel}_status` as const]]));
            const line = `\n${[
                row.id,
                row.name,
                row.phone,
                row.email ?? "",
                customerKind({ accountClaimedAt: row.accountClaimedAt, origin: row.origin }),
                row.cityName ?? "",
                row.zoneName ?? "",
                Number(row.ordersCount),
                fromMinor(Number(row.totalSpentMinor), Number(row.decimalPlaces)),
                isoDate(row.firstOrderAt),
                isoDate(row.lastOrderAt),
                (tags.get(row.id) ?? []).join(", "),
                statuses.email,
                statuses.sms,
                statuses.whatsapp,
                isoDate(row.createdAt),
                row.countryCode ?? "",
                statuses.push,
            ].map(spreadsheetSafeCsvCell).join(",")}`;
            const bytes = encoder.encode(line).byteLength;
            if (byteLength + bytes > CUSTOMER_EXPORT_MAX_BYTES) {
                limited = true;
                break;
            }
            chunks.push(line);
            byteLength += bytes;
            rowCount += 1;
        }
        if (page.length < PAGE) break;
        afterId = page[page.length - 1]!.id;
    }
    return { body: chunks.join(""), byteLength, rowCount, limited };
}
