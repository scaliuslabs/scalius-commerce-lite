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
  version: 159,
  name: "0159_order_tracking_signals",
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
    version: 100,
    name: "0100_cache_dependencies",
    sourceSha256: "2d18253c98e70a3a58d155aa13cc91d876dbd3456ed90cda7696b497699be33f",
  },
  {
    version: 101,
    name: "0101_cache_ordering_dependencies",
    sourceSha256: "0928892cb6b70b1f25af79fc03d293d0ad28634617c0fce0d0eb79be8c276e7a",
  },
  {
    version: 102,
    name: "0102_inventory_locations",
    sourceSha256: "42507a4db0dbaa14d05e60a2bc85a6cbd17f988e2edc6635a848ff5e9193626e",
  },
  {
    version: 103,
    name: "0103_order_channel_event_outbox",
    sourceSha256: "aea0cc76afe248d854897da514a934d53b9aca0c2c5f1753b6902cd136c9d14b",
  },
  {
    version: 104,
    name: "0104_custom_fields",
    sourceSha256: "cd82986061df2a502c2140d43e2d817cee190f26052352825b2751d910e9b2b1",
  },
  {
    version: 105,
    name: "0105_plugin_runtime",
    sourceSha256: "779873f178ae9054a4f80c99ec75a6d0e38ae9e77e95ec7b07dd924c85397033",
  },
  {
    version: 106,
    name: "0106_theme_document_v6",
    sourceSha256: "4a5b61c81ae7d43f42eb0df4a36ab3d80af1dd3feab350a5af3d0f3da34eef50",
  },
  {
    version: 107,
    name: "0107_plugin_platform",
    sourceSha256: "42b0d0c152ece0f8b2aac7d4557f4326831d83a1f653e960356eb6fc344a9148",
  },
  {
    version: 108,
    name: "0108_customer_marketing",
    sourceSha256: "a4b6972ec3a9e64299d547b220d4682a84a8885d02f78cc2868ae4510e8bb77e",
  },
  {
    version: 109,
    name: "0109_inventory_purchasing",
    sourceSha256: "3aa95b32b38c1dd3a94562822ab76ede11ea56829df22f337443fb375fc08aa1",
  },
  {
    version: 110,
    name: "0110_plugin_providers",
    sourceSha256: "32b8eee16f47ec6363dd95a9ab710cfb6fcd8bcef8a2fbf86d9601aabe9c9dcd",
  },
  {
    version: 111,
    name: "0111_order_money_chain",
    sourceSha256: "19d1617b34d3c5f245a316505431358960578e214440de499ab3fb33f58f6833",
  },
  {
    version: 112,
    name: "0112_markets",
    sourceSha256: "b558d17ad0707700f956c46aa7c892760df786f7dddd34b781ef7b56ae2b13e8",
  },
  {
    version: 113,
    name: "0113_country_aware_addresses",
    sourceSha256: "b7331d0aab61c2fc111305687d7350db463fec9b07fdf69d670da6cb32b1bd59",
  },
  {
    version: 114,
    name: "0114_shipping_zones",
    sourceSha256: "26615b7089869e68377d7a7b14f7a6d644c01597c0311c81a10d362ee682da22",
  },
  {
    version: 115,
    name: "0115_selling_countries_dependency",
    sourceSha256: "371fa529b5b3a6cb9294666fc7aa157809279fd8d656a2571e67074c3d36c0c3",
  },
  {
    version: 116,
    name: "0116_tax_regions",
    sourceSha256: "53d7b81d453e5b766329f75c5ad260282fb3b1e2aabd2295904112ea0e887410",
  },
  {
    version: 117,
    name: "0117_phoneless_guest_customers",
    sourceSha256: "338a5618e830be7296da04d94e3c574293dfa849d917258fa64d5fe589cdbd6e",
  },
  {
    version: 118,
    name: "0118_places",
    sourceSha256: "dc815805ef4e280f62f3ea15e0dd81b7e001cf246bdc34244cfd8a9f2f8286d1",
  },
  {
    version: 119,
    name: "0119_billing_addresses",
    sourceSha256: "bb8841b6bea9fc52dc1cbb7f01a3285128e3dfb3eb988447a97512b7af025c8a",
  },
  {
    version: 120,
    name: "0120_price_lists",
    sourceSha256: "79cc8a68ea53ea7d0bf32662d98755c46384e1d1e1ea8018d405c325967c3ae4",
  },
  {
    version: 121,
    name: "0121_translations",
    sourceSha256: "bd4bc6821c6f8787a33e888a51e71ac2a562ea3dc7c4ec57b9192ae00d9ad8b4",
  },
  {
    version: 122,
    name: "0122_sales_channels",
    sourceSha256: "7a6b5cac792843fd099faa6d18fe59aa54ce4ff5defe29d2e34a72218e15e69d",
  },
  {
    version: 123,
    name: "0123_market_currencies",
    sourceSha256: "6c6cf8a662eef18fd8a097c8dd413acb6a85a681d150d355d08e9b5549770977",
  },
  {
    version: 124,
    name: "0124_theme_restore_points",
    sourceSha256: "decd435dea4269c949c02ee9ab7e5153b50588a1d755caacfb78cad308e6c346",
  },
  {
    version: 125,
    name: "0125_plugin_lifecycle",
    sourceSha256: "b7db1cf080686c02603d68663907a68b828185e461033eb2f357a00ad3fdb6d0",
  },
  {
    version: 126,
    name: "0126_plugin_seams",
    sourceSha256: "470fbd59758360fd69f2f9e5e26fef0aed345040ef924cc5d118a213a2e60614",
  },
  {
    version: 127,
    name: "0127_list_indexes",
    sourceSha256: "8961702f56aa42ccd156bd6c9318f666d798ad1f9ad38acf3d8ec47fb53d5641",
  },
  {
    version: 128,
    name: "0128_scale_reads",
    sourceSha256: "4e7c00ff5c929a14749b56998a7438d7400e58c10ca30d7d18ba7016e0fa6d46",
  },
  {
    version: 129,
    name: "0129_order_overview_reads",
    sourceSha256: "4f41144a82c1af38c4f424420a934349dadee48fb1bd499b0911f5991d2a2f65",
  },
  {
    version: 130,
    name: "0130_dashboard_home_reads",
    sourceSha256: "9c267be236741e264c6d958f5c811d23835bf4d98447f4185f5b8e31431a78dc",
  },
  {
    version: 131,
    name: "0131_analytics_rollup",
    sourceSha256: "77097e27fd9d135018c543306841f8c407482a9e5cfac4f9fd67c29fd09b296f",
  },
  {
    version: 132,
    name: "0132_recommendation_buyers",
    sourceSha256: "09e8b41890bbf74b0a60309e229f58f5a50465e85959aac3e226b02b2c46ba64",
  },
  {
    version: 133,
    name: "0133_customer_sale_endpoints",
    sourceSha256: "ed33c27cab213caf9fa3271322213ddae5f8b44150fafbd09bba30d95fb28aa8",
  },
  {
    version: 134,
    name: "0134_media_text_index",
    sourceSha256: "5592fb3f544a55e9e6b6ac79f1b0c29095edba5c93a001813d096d171f19ca09",
  },
  {
    version: 135,
    name: "0135_inventory_valuation_indexes",
    sourceSha256: "2b1d6f6b768585f73744123210b8e65da0e2cb86ecb80cf0c7f0dd14208fc212",
  },
  {
    version: 136,
    name: "0136_buyer_state_covering_index",
    sourceSha256: "a37534e890574e9a2f21de767c61abb402209ff11d3003d8ce26cc40e2282494",
  },
  {
    version: 137,
    name: "0137_recommendation_order_id",
    sourceSha256: "6ff4dc3443b5a6107534f6cedc89a91afba4379b5d89d80145bb51603064907a",
  },
  {
    version: 138,
    name: "0138_facet_public_counts",
    sourceSha256: "9e87537b956c98fa93c06a8f38b19bc69f728e63d57c50fc2ab7fbada2049a12",
  },
  {
    version: 139,
    name: "0139_recommendation_order_products",
    sourceSha256: "77125e88788835063573d29d56110ace40717ffc7f5f6b36f63493c30eb10e1b",
  },
  {
    version: 140,
    name: "0140_buyer_public_counts",
    sourceSha256: "19c716c082664532fb7713c394ba5ad5e22ed10286baffd15334111894a6acf9",
  },
  {
    version: 141,
    name: "0141_conversation_inbox_counts",
    sourceSha256: "886ffd9c32edbc158b438a0f8b70bd56ecf360f58731a70998f2ef278230ab17",
  },
  {
    version: 142,
    name: "0142_staff_alerts",
    sourceSha256: "5ddd58e089344b0cdbc23e106b5cf9ef32c0ef0d996f6e25cf5418e49c9f5e08",
  },
  {
    version: 143,
    name: "0143_remaining_polish",
    sourceSha256: "d479468027dc2a6b0506b24e8bed8a57a1a9bc82067e2497abea5691fdeacb00",
  },
  {
    version: 144,
    name: "0144_customer_contact_lookup",
    sourceSha256: "af1d0f484acdf26802798a42068b659a70e4d8d667db2eed7476432e1968daa7",
  },
  {
    version: 145,
    name: "0145_conversation_search_cursor",
    sourceSha256: "b91a94f2a2a37b0a0ff124a49e9b0b5ed03ab943049416c0c2aec709a4a74b8f",
  },
  {
    version: 146,
    name: "0146_order_write_path",
    sourceSha256: "3801adf16e889edd6f221afcc363e00edaf8fc143a8269a4519366e43c1d8ec0",
  },
  {
    version: 147,
    name: "0147_kv_retirement",
    sourceSha256: "786ba414dbaf965411cc75b99f79007253d2bdcf1e7bc1423e7d04dc23158dd7",
  },
  {
    version: 148,
    name: "0148_queue_retirement",
    sourceSha256: "d903535e44c7c404bbd08c2951a91becc2096b6d51f7d3cfb7a1299be91dfd9f",
  },
  {
    version: 149,
    name: "0149_strict_readers_reset",
    sourceSha256: "baf742367eff349777d07762e938980de263094ac2721e7c6c027ab6f0510c25",
  },
  {
    version: 150,
    name: "0150_facet_engine",
    sourceSha256: "8a8b3c43467345d999d1f9be32ad19346ef1bf584dd84c0438af2d6c84d87a60",
  },
  {
    version: 151,
    name: "0151_postgres_scale",
    sourceSha256: "959ce66f33eab4b3ecc54e59371b3a4e6b621198f0bd8f5f6504acebe99ab234",
  },
  {
    version: 152,
    name: "0152_search_index",
    sourceSha256: "32c542b59fa136f6dbb7ec51231204dbebced72504c0f15ea7e2ff2a2316e13a",
  },
  {
    version: 153,
    name: "0153_theme_skins",
    sourceSha256: "d0be879752ec302b137e897dea2cd1bd0c1778240d556dbd9ab5e310f5f8ed02",
  },
  {
    version: 154,
    name: "0154_order_number_sequence",
    sourceSha256: "417d5e9f53ea735a4d49aa74b85a3cbe3450c0c8e348808daa21689243552ac7",
  },
  {
    version: 155,
    name: "0155_v2_beta_contract",
    sourceSha256: "5c507b12e9e4f51c1124cf2d804b34e179e6c5eb755eef62ef7bb7a7342e5112",
  },
  {
    version: 156,
    name: "0156_custom_field_object_references",
    sourceSha256: "801e0c8d279cdc8a0df80ddea09bfecf60f9592fa2bf10f5fed1728e3d1bf4da",
  },
  {
    version: 157,
    name: "0157_order_search_update_guards",
    sourceSha256: "82dd0eaab9a95115f9f744284962f88b16e4b98c50b3b2f7b658fe7837f87424",
  },
  {
    version: 158,
    name: "0158_app_access_contract",
    sourceSha256: "426ef68a6024a8e1a7f18f0bfc6defe19a0e35ef835f5acf1a049505af275493",
  },
  {
    version: 159,
    name: "0159_order_tracking_signals",
    sourceSha256: "2288de59a047c4daea18883f65b105cf4b2be5fc9004f85311611b0dc9301382",
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
