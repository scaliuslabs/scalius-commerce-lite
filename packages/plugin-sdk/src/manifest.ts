// `@scalius/plugin-sdk/manifest`: the manifest parser and the contract's
// tables and schemas, for tooling, tests and a webhook receiver. Separate
// from the root entry so plugin bundles do not include the schemas.
export {
  parsePluginManifest,
  pluginFeatureRequest,
  pluginGrantRequest,
  pluginManifestWithFeatures,
  PLUGIN_EXTENSION_SCHEMAS,
  PLUGIN_FUNCTION_SCHEMAS,
  type PluginManifest,
  type PluginManifestInput,
} from "@scalius/shared/plugins";
/** Which words of a manifest still fall back to English for a language (`translationCoverage(manifest, "bn").missing`). */
export { translationCoverage, type TranslationCoverage } from "@scalius/shared/plugins/translation-coverage";
/** The event catalogue: every topic, the resource it is about, its facts and each resource's sealed representation; and webhook signing. */
export {
  EVENT_FACT_SCHEMAS,
  EVENT_REPRESENTATION_SCHEMAS,
  EVENT_TOPIC_RESOURCE,
  EVENT_TOPICS,
  signWebhookPayload,
  verifyWebhookSignature,
  type EventTopic,
} from "@scalius/shared/events";
/** The field types of custom fields and object fields. */
export { CUSTOM_FIELD_TYPES } from "@scalius/shared/custom-fields";
/** The closed state lists of the resources an app reads (decide money from `paymentStatus`, hand-over from `fulfillmentStatus`). */
export {
  FULFILLMENT_RECORD_STATUSES,
  FULFILLMENT_STATUSES,
  GIFT_CARD_STATUSES,
  ORDER_STATUSES,
  PAYMENT_RECORD_STATUSES,
  PAYMENT_STATUSES,
  REFUND_STATUSES,
  RETURN_STATUSES,
  SHIPMENT_STATUSES,
} from "@scalius/shared/resource-states";
/** Each provider port's required and optional operations, and its tier (stable or beta). */
export { PROVIDER_OPERATIONS, PROVIDER_PORT_TIERS } from "@scalius/shared/plugins/providers/kinds";
