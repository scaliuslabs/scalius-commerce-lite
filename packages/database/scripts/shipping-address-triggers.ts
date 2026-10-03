/**
 * The per-country shipping-address triggers on `orders` and the address-book
 * seed (MARKETS-DESIGN D7, migration 0113), generated for D1/Turso and
 * PostgreSQL. Migration 0113 must contain every generated statement verbatim
 * (`__tests__/country-aware-addresses-migration.test.ts`).
 *
 * `orders_shipping_address_required_{insert,update}`: a shipped order
 * (`requires_shipping = 1`) has a first street line. Bangladesh also needs
 * its City and Thana (the courier ids of the delivery adapter). Every order
 * writer sets the country; a row written by raw SQL without one counts as
 * Bangladesh, as before 0113 (the `market_id` rule of 0112).
 * Another country needs each field its libaddressinput rules require
 * (locality, admin area, postal code, dependent locality), unless staff saved
 * it with validation skipped. The country lists come from
 * `@scalius/shared/address-metadata`; regenerating that table with changed
 * required fields fails the test until a new migration installs the new
 * trigger.
 *
 * `orders_seed_customer_address`: a guest record (no account) that has no
 * saved address takes the first shipping order's snapshot as its default
 * address (id `firstCustomerAddressId`: no `customer.updated` beside the
 * record's `customer.created`). One rule for every order writer (checkout,
 * staff, agents), and no extra statement in any of their batches. Accounts are never written by an
 * order (a guest checkout never changes an account; MARKETS-DESIGN step 3a).
 *
 * The bodies are one statement without CASE (remote D1 rule); the guards are
 * the WHEN clauses.
 */
import { DELIVERY_HIERARCHY_COUNTRY } from "../../shared/src/markets";
import { ADDRESS_COUNTRY_CODES, countriesRequiringAddressField } from "../../shared/src/address-metadata";
import { CUSTOMER_ADDRESS_ID_PREFIX } from "../src/schema/customers";
import { compileSqliteTriggerForPostgres } from "./postgres-schema";

export const SHIPPING_ADDRESS_TRIGGER_MIGRATION = "0113_country_aware_addresses";

const REQUIRED_FIELD_COLUMNS = [
  ["locality", "shipping_locality"],
  ["adminArea", "shipping_admin_area"],
  ["postalCode", "shipping_postal_code"],
  ["dependentLocality", "shipping_dependent_locality"],
] as const;

type RequiredField = (typeof REQUIRED_FIELD_COLUMNS)[number][0];

/**
 * Which countries (other than Bangladesh) must have a field, written the
 * short way: `|AE|AU|…|` listed (`listed: true`), or, when most countries
 * require it (the locality), the countries that do not (`listed: false`).
 */
export function requiredCountryList(field: RequiredField): { list: string; listed: boolean } {
  const required = new Set(countriesRequiringAddressField(field));
  const others = ADDRESS_COUNTRY_CODES.filter((code) => code !== DELIVERY_HIERARCHY_COUNTRY);
  const requiring = others.filter((code) => required.has(code));
  const exempt = others.filter((code) => !required.has(code));
  return requiring.length <= exempt.length
    ? { list: `|${requiring.join("|")}|`, listed: true }
    : { list: `|${exempt.join("|")}|`, listed: false };
}

/** The trigger guard: the shipped order's address breaks its country's rule. */
export function shippingAddressMissingCondition(): string {
  const ruleChecks = REQUIRED_FIELD_COLUMNS.map(([field, column]) => {
    const { list, listed } = requiredCountryList(field);
    return `(instr('${list}', '|' || NEW.\`shipping_country_code\` || '|') ${listed ? "> 0" : "= 0"} AND coalesce(trim(NEW.\`${column}\`), '') = '')`;
  });
  return [
    "NEW.`requires_shipping` = 1",
    "  AND (",
    "    NEW.`shipping_address` IS NULL OR trim(NEW.`shipping_address`) = ''",
    `    OR (coalesce(NEW.\`shipping_country_code\`, '${DELIVERY_HIERARCHY_COUNTRY}') = '${DELIVERY_HIERARCHY_COUNTRY}' AND (NEW.\`city\` IS NULL OR NEW.\`zone\` IS NULL))`,
    `    OR (NEW.\`shipping_country_code\` <> '${DELIVERY_HIERARCHY_COUNTRY}' AND NEW.\`shipping_validation_skipped\` = 0 AND (`,
    `      ${ruleChecks.join("\n      OR ")}`,
    "    ))",
    "  )",
  ].join("\n");
}

/** Columns whose change re-checks the address. */
const CHECKED_COLUMNS = [
  "requires_shipping",
  "shipping_address",
  "shipping_country_code",
  "city",
  "zone",
  "shipping_locality",
  "shipping_admin_area",
  "shipping_postal_code",
  "shipping_dependent_locality",
  "shipping_validation_skipped",
];

/** Order snapshot column → address-book column, for the seed. */
const SEED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["country_code", "shipping_country_code"],
  ["name", "shipping_name"],
  ["company", "shipping_company"],
  ["line1", "shipping_address"],
  ["line2", "shipping_address_line2"],
  ["dependent_locality", "shipping_dependent_locality"],
  ["locality", "shipping_locality"],
  ["admin_area", "shipping_admin_area"],
  ["postal_code", "shipping_postal_code"],
  ["phone_e164", "shipping_phone"],
  ["city", "city"],
  ["zone", "zone"],
  ["area", "area"],
  ["city_name", "city_name"],
  ["zone_name", "zone_name"],
  ["area_name", "area_name"],
  ["validation_skipped", "shipping_validation_skipped"],
];

export interface ShippingAddressTrigger {
  name: string;
  sqlite: string;
}

export function generateShippingAddressTriggers(): ShippingAddressTrigger[] {
  const condition = shippingAddressMissingCondition();
  const raise = "BEGIN\n  SELECT RAISE(ABORT, 'shipping address required');\nEND";
  return [
    {
      name: "orders_shipping_address_required_insert",
      sqlite: `CREATE TRIGGER \`orders_shipping_address_required_insert\`\nBEFORE INSERT ON \`orders\`\nWHEN ${condition}\n${raise}`,
    },
    {
      name: "orders_shipping_address_required_update",
      sqlite: `CREATE TRIGGER \`orders_shipping_address_required_update\`\nBEFORE UPDATE OF ${CHECKED_COLUMNS.map((column) => `\`${column}\``).join(", ")} ON \`orders\`\nWHEN ${condition}\n${raise}`,
    },
    {
      name: "orders_seed_customer_address",
      sqlite: [
        "CREATE TRIGGER `orders_seed_customer_address`",
        "AFTER INSERT ON `orders`",
        "WHEN NEW.`customer_id` IS NOT NULL",
        "  AND NEW.`requires_shipping` = 1",
        "  AND NEW.`shipping_country_code` IS NOT NULL",
        "  AND NOT EXISTS (SELECT 1 FROM `customer_addresses` WHERE `customer_id` = NEW.`customer_id`)",
        "  AND EXISTS (SELECT 1 FROM `customers` WHERE `id` = NEW.`customer_id` AND `account_claimed_at` IS NULL)",
        "BEGIN",
        `  INSERT INTO \`customer_addresses\` (\`id\`, \`customer_id\`, \`is_default\`, ${SEED_COLUMNS.map(([target]) => `\`${target}\``).join(", ")})`,
        `  VALUES ('${CUSTOMER_ADDRESS_ID_PREFIX}' || NEW.\`customer_id\`, NEW.\`customer_id\`, 1, ${SEED_COLUMNS.map(([, source]) => `NEW.\`${source}\``).join(", ")});`,
        "END",
      ].join("\n"),
    },
  ];
}

export function shippingAddressSqliteStatements(): string[] {
  return generateShippingAddressTriggers().map((trigger) => trigger.sqlite);
}

export function shippingAddressPostgresStatements(): string[] {
  return generateShippingAddressTriggers().map((trigger) =>
    compileSqliteTriggerForPostgres({ name: trigger.name, sql: trigger.sqlite }));
}
