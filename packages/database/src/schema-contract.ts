import { asc } from "drizzle-orm";

import { scaliusSchemaMigrations } from "./schema";
import type { Database } from "./types";

export const DATABASE_SCHEMA_CONTRACT_VERSION =
  "scalius-database-schema/v1" as const;

/**
 * First provider-neutral migration identity. Releases before this point used
 * Wrangler's D1 ledger or one-shot, fingerprinted external-provider imports.
 */
export const DATABASE_SCHEMA_LEGACY_BASELINE = {
  version: 49,
  name: "0049_checkout_side_effect_authority_fence",
  tursoSchemaObjects: 532,
  tursoSchemaSha256:
    "1d34f85ddd9c40e27170a378f5082c71ea0ceb7abfbb6c7c52bf041904fdb997",
  postgresSchemaBundleVersion: "scalius-postgres-schema/v1",
  postgresSchemaSha256:
    "6c34b131affc800a6c0912d5922d3e5ded04a131135b8f5c3d64c40e0c691baf",
} as const;

export const CURRENT_DATABASE_SCHEMA = {
  version: 100,
  name: "0100_cache_dependencies",
} as const;

export const CURRENT_DATABASE_SCHEMA_MIGRATIONS = [
  {
    version: 50,
    name: "0050_schema_release_contract",
    sourceSha256: "4b7e98071b3874f0a1e512b3bac3a188fdfb087f9cb118df9cd0fd8a77205194",
  },
  {
    version: 51,
    name: "0051_orders_checkout_write_path",
    sourceSha256: "be810d0a125e0ab2900e89bfa70a05d67b3b280cc0092a19e1016792a09288cc",
  },
  {
    version: 52,
    name: "0052_remove_storefront_cache_queue",
    sourceSha256: "3f010183c503a22006650e8c01a746e83dc8f600bbb101075c8583c2f07cf62c",
  },
  {
    version: 53,
    name: "0053_checkout_language_authority",
    sourceSha256: "eaac242dba1606345bde9433d3d883e56605b44ce3d6f52be3b999aa6a588e9d",
  },
  {
    version: 54,
    name: "0054_cache_invalidation_delivery",
    sourceSha256: "79be02aabbc23a8df2d1d249411c3940ae3389d12981b2a0ff81dad7b15476fa",
  },
  {
    version: 55,
    name: "0055_cache_invalidation_postgres_bigint",
    sourceSha256: "1fef4f2d630a3dbd5de4255b37b9d4896e325f99f6975d3c486fd1252e47cda4",
  },
  {
    version: 56,
    name: "0056_agent_access",
    sourceSha256: "ca86ab76f26135b9e6ea259c40c474e6e83ef510ed7544ecb990a4fbc09d1af4",
  },
  {
    version: 57,
    name: "0057_agent_browser_handoffs",
    sourceSha256: "21a478e92ac14c9b36488179f3a9c36ce847700fa99c74e85089798b709db155",
  },
  {
    version: 58,
    name: "0058_order_shipping_method_snapshot",
    sourceSha256: "a0c66a84c1652e000e26d37adc8f7331afef9cc5284eb3b152fe63c389545217",
  },
  {
    version: 59,
    name: "0059_checkout_delivery_phone_identity",
    sourceSha256: "a5759548b627414ea6cf4e687413fa07895ed225b748305f13be18d810b0a9fd",
  },
  {
    version: 60,
    name: "0060_better_auth_account_identity",
    sourceSha256: "ad85b0d511efec1d4b538f231cbb96503faf11f4844d36671c9c8b196aa318c8",
  },
  {
    version: 61,
    name: "0061_regular_hex",
    sourceSha256: "d324f4bd25505b7f4ac6ff25e611c581febbcee8e6c0f16b2fd867782c481cb8",
  },
  {
    version: 62,
    name: "0062_identity_handoff_audit",
    sourceSha256: "c514c87ba34755f276246babc6d94a012a39a9e839919c5114539d41378c4cf7",
  },
  {
    version: 63,
    name: "0063_media_variants_drop_polar",
    sourceSha256: "c5b1317a03ab33940205e39cbd6217552e5322aef9291beea5fdad18ca93211e",
  },
  {
    version: 64,
    name: "0064_cache_generation",
    sourceSha256: "ee5ed733611d28c5b676b0e5e48d9eb3e0b9d1ed813b329814aaa0906bcca823",
  },
  {
    version: 65,
    name: "0065_single_checkout_commit",
    sourceSha256: "b00f8d765b7c4851d6547678a02cd94be2c0ae6d7e42df46de845361df4d08fb",
  },
  {
    version: 66,
    name: "0066_payment_provider_refs",
    sourceSha256: "49f766711be807af246f7a7c6c5ac1984dff6b49000ab73fce487f53d902d3b7",
  },
  {
    version: 67,
    name: "0067_settings_documents",
    sourceSha256: "cdf999ee82cb87fb8811552eb1d76d87a99d36eecf0508c4ac742699504f0205",
  },
  {
    version: 68,
    name: "0068_single_discount_engine",
    sourceSha256: "9c33e0354f8b670c98596fbfa9daa760198a6fed7287c309293a4661ff5d8ce3",
  },
  {
    version: 69,
    name: "0069_integer_money",
    sourceSha256: "852add8cc9569b0f85a12fefb59f2e0d863bca2fb4c248768de79f9d2b274737",
  },
  {
    version: 70,
    name: "0070_order_numbers_timeline",
    sourceSha256: "c25a4602a4cd7bbb42a7d3b8e539c30b553d26c0614cf61395df84ddaf3d6b89",
  },
  {
    version: 71,
    name: "0071_buyer_identity",
    sourceSha256: "cd97b292a1a55b5fa0c99624a080d57bd92f79f62a9b1a4ed68bf86f2064c2b2",
  },
  {
    version: 72,
    name: "0072_delivery_zones",
    sourceSha256: "d30f2fc33db16f5c02a5b8be890d9cad078975edf126d6fc6b14c2c33d77cafd",
  },
  {
    version: 73,
    name: "0073_combinable_discount_codes",
    sourceSha256: "f0cce9701c13e51366a10988ce7595395b1e7763523fa8180acc17b9273ea582",
  },
  {
    version: 74,
    name: "0074_verified_customer_identity",
    sourceSha256: "e678a6ac0d06ccaa55b95159fd8fd4564e262356c4694254d3cd4729004b36d6",
  },
  {
    version: 75,
    name: "0075_theme_layout_reset",
    sourceSha256: "0fa004dc4ff1f70f010f91526b9a9f571ad2b8af382277503613fc445d933597",
  },
  {
    version: 76,
    name: "0076_guest_record_links",
    sourceSha256: "728ad7d908c014099cbc7bc8a70441867568585ddc9e9ba2dae46776106bbbe6",
  },
  {
    version: 77,
    name: "0077_optioned_product_price",
    sourceSha256: "4e6fe06299dfaa5c0c4980454b308b76e158202a73327b375a31c1fdc83a33d0",
  },
  {
    version: 78,
    name: "0078_theme_document_v2",
    sourceSha256: "f9097a979abd80378e94d9afec34363da94b31584f55bd71af717f2bdaafae1a",
  },
  {
    version: 79,
    name: "0079_guest_record_origin",
    sourceSha256: "95b284f716293447b94c3474bf53e21d0262ed589ed91ed1087084bcbb7f1c2b",
  },
  {
    version: 80,
    name: "0080_whole_taka_amounts",
    sourceSha256: "a88163d1389ab6e37e1812c5d11a35bfdb01e692be58fbdf2c328bc6c5ee631c",
  },
  {
    version: 81,
    name: "0081_theme_document_v3",
    sourceSha256: "d99b5418ee7a5a49a20ad5bfbeaec54e8c9f8df6fc9efeedf27a4604c574fe2f",
  },
  {
    version: 82,
    name: "0082_theme_document_v4",
    sourceSha256: "3edcdcf0fe41c442226db15d6f130d4f70517ed2a0527ae280943e07d4f40e4f",
  },
  {
    version: 83,
    name: "0083_order_line_fulfilment",
    sourceSha256: "03d720537b4e7efef98e38074a3c474b2caeaf6b8cdc71c3ca84a63ac5024d19",
  },
  {
    version: 84,
    name: "0084_line_item_properties",
    sourceSha256: "1f42c2521eea8cde9cf60290b46498b3f2e54099c8218dcd3781ee47c1da5aac",
  },
  {
    version: 85,
    name: "0085_conversations",
    sourceSha256: "3fdfc007bc43f1c35b0f0590d72f7bd4b639cf4cd970dd4c25d14702894b62af",
  },
  {
    version: 86,
    name: "0086_notification_outbox",
    sourceSha256: "fb4be5e48fcf6535d7ef7334d7548415fc40eeb4438d9746e65cf9d00e35676f",
  },
  {
    version: 87,
    name: "0087_on_sale_indexes",
    sourceSha256: "5b44f31ff08b9543d6818f86c0af8a6832456e35a274838e660dc6ae009e2795",
  },
  {
    version: 88,
    name: "0088_wave_a_contract",
    sourceSha256: "e7d67648b6beea33bc539e988256fc0e1b378be208b42b27272e8560c4b495a2",
  },
  {
    version: 89,
    name: "0089_wave_a_contract_columns",
    sourceSha256: "8fecfe8de769120f1d525cb7cd0ec5595246074dd46f623e55bd7f3a6f63dc79",
  },
  {
    version: 90,
    name: "0090_catalogue_schema",
    sourceSha256: "0c4e0fe4d503aaeda11d492acb521f8740e64073427df0c2d2e2ed9802bf0ecf",
  },
  {
    version: 91,
    name: "0091_catalogue_projection_fill",
    sourceSha256: "f517802465dd78eb25c3688f3b7dd9b0ac2ebe58dbf1b124fb4758f538ea0531",
  },
  {
    version: 92,
    name: "0092_attribute_option_presets",
    sourceSha256: "81dabf4bfe6ec2627963d55b32f3e44c6693fd523cf550dff6f2c6be1dea2328",
  },
  {
    version: 93,
    name: "0093_theme_document_v5",
    sourceSha256: "1d8c43a620127ad07a2d9dbb76747f4c5675e34d18757a268a4974dadac3c031",
  },
  {
    version: 94,
    name: "0094_media_rendition_ladder",
    sourceSha256: "93b5a9bc09941bd072a7efa637730fc8c9e6b588fdd6688f7e2d82f54ffd5762",
  },
  {
    version: 95,
    name: "0095_reviews",
    sourceSha256: "f0fa69308e86a712f5bcb7c80e126f17d15dbe449fcd3e5f6996100f9dd644f0",
  },
  {
    version: 96,
    name: "0096_digital_goods",
    sourceSha256: "b78be4c196d831cc0fc824fd82c1e66dbc4a9a845b3bef256bde87ee0c5ab718",
  },
  {
    version: 97,
    name: "0097_gift_cards",
    sourceSha256: "fd607d50e3f023546e39295dcef0511471a4437b2fdde71261c0b9fe0dcbd800",
  },
  {
    version: 98,
    name: "0098_warranty",
    sourceSha256: "14c9d0b08f87f5ad5cd87ec3e57fe5dc119008f3923975f400af5d54ecf3e2d7",
  },
  {
    version: 99,
    name: "0099_customer_whatsapp",
    sourceSha256: "50e207ecaf45d21cf0b12fad93cd0a7ac24f8e3b8e1b21d8255ca9be3cf31ecf",
  },
  {
    ...CURRENT_DATABASE_SCHEMA,
    sourceSha256: "e1654d5c5f1dda04ab9e11576496980eccdaffd323df70bb0e8a8726a4a78a1f",
  },
] as const;

export interface DatabaseSchemaState {
  version: number;
  name: string;
}

export interface DatabaseSchemaMigration extends DatabaseSchemaState {
  sourceSha256: string;
}

function normalizeSchemaMigration(row: {
  version: unknown;
  name: unknown;
  sourceSha256: unknown;
}): DatabaseSchemaMigration {
  const version = Number(row.version);
  const name = typeof row.name === "string" ? row.name : "";
  const sourceSha256 = typeof row.sourceSha256 === "string"
    ? row.sourceSha256
    : "";
  if (
    !Number.isSafeInteger(version)
    || version < 1
    || !name
    || !/^[a-f0-9]{64}$/.test(sourceSha256)
  ) {
    throw new Error("Database schema migration authority is invalid.");
  }
  return { version, name, sourceSha256 };
}

export function assertDatabaseSchemaCompatible(
  rows: readonly {
    version: unknown;
    name: unknown;
    sourceSha256: unknown;
  }[] | undefined,
): DatabaseSchemaState {
  if (!rows || rows.length === 0) {
    throw new Error("Database schema migration authority is missing.");
  }
  const migrations = rows.map(normalizeSchemaMigration);
  if (migrations.length !== CURRENT_DATABASE_SCHEMA_MIGRATIONS.length) {
    throw new Error(
      `Database schema migration ledger has ${migrations.length} row(s); expected `
      + `${CURRENT_DATABASE_SCHEMA_MIGRATIONS.length}.`,
    );
  }
  for (let index = 0; index < migrations.length; index += 1) {
    const actual = migrations[index]!;
    const expected = CURRENT_DATABASE_SCHEMA_MIGRATIONS[index]!;
    if (
      actual.version !== expected.version
      || actual.name !== expected.name
      || actual.sourceSha256 !== expected.sourceSha256
    ) {
      throw new Error(
        `Database schema migration ledger diverges at version ${expected.version}.`,
      );
    }
  }
  return CURRENT_DATABASE_SCHEMA;
}

export async function readDatabaseSchemaState(
  database: Database,
): Promise<DatabaseSchemaState> {
  const rows = await database
    .select({
      version: scaliusSchemaMigrations.version,
      name: scaliusSchemaMigrations.name,
      sourceSha256: scaliusSchemaMigrations.sourceSha256,
    })
    .from(scaliusSchemaMigrations)
    .orderBy(asc(scaliusSchemaMigrations.version))
    .all();
  return assertDatabaseSchemaCompatible(rows);
}
