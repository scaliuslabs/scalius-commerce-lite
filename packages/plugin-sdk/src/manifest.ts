// Manifest validation for tooling and tests (`@scalius/plugin-sdk/manifest`).
// Separate from the root entry so plugin bundles do not include the schemas.
export {
  parsePluginManifest,
  pluginFeatureRequest,
  pluginGrantRequest,
  pluginManifestWithFeatures,
  type PluginManifest,
  type PluginManifestInput,
} from "@scalius/shared/plugins";
