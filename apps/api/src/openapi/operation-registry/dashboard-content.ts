// Agent operation registry rows for the dashboard content, media, navigation and theme routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_CONTENT_OPERATIONS = {
  "dashboard.content.bulk_delete": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.content.bulk_publish": {
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.content.bulk_restore": {
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.content.bulk_unpublish": {
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.content.create": { stability: "stable" },
  "dashboard.content.get": { stability: "stable" },
  // Page-numbered (dashboard-shaped): beta until a cursor list joins the stable API.
  "dashboard.content.list": {},
  "dashboard.content.permanently_delete": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.content.restore": {
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.content.trash": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.content.update": { stability: "stable", revision: "required" },
  "dashboard.media_folders.create": {},
  "dashboard.media_folders.delete": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.media_folders.list": {},
  "dashboard.media_folders.update": { revision: "required" },
  "dashboard.media.import_url": {
    stability: "stable",
    openWorld: true,
    batch: "forbidden",
  },
  "dashboard.media.get": { stability: "stable" },
  "dashboard.media.list": { stability: "stable" },
  "dashboard.media.move": { revision: "required" },
  "dashboard.media.original": {
    exposure: "excluded",
    reason: "Binary original read for the dashboard's browser rendition pipeline; agents use the public media URL.",
  },
  "dashboard.media.permanently_delete": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.media.restore": { revision: "required" },
  "dashboard.media.trash": {
    stability: "stable",
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.media.update": { stability: "stable", revision: "required" },
  "dashboard.media.usage": {},
  "dashboard.media.upload_abort": { limits: { response: 16_384 } },
  "dashboard.media.upload_complete": {},
  "dashboard.media.upload_get": { limits: { response: 16_384 } },
  "dashboard.media.upload_initiate": { limits: { response: 16_384 } },
  "dashboard.media.upload_part": {
    batch: "forbidden",
    transport: "octet-stream",
    limits: { request: 5_242_880, response: 16_384 },
    clientAction: "direct-upload",
  },
  "dashboard.media.upload_reconcile": {
    exposure: "excluded",
    reason: "Internal expired-upload maintenance is not a merchant capability.",
  },
  // The CLI encodes the ladder locally (sharp) and sends it here after the
  // upload completes. Agents without a local encoder (MCP, URL import) skip
  // this: their images stay pending until a dashboard tab renders them.
  "dashboard.media.variants_save": {
    batch: "forbidden",
    transport: "multipart",
    limits: { request: 16_777_216, response: 16_384 },
  },
  "dashboard.navigation.items_create": { revision: "required" },
  "dashboard.navigation.items_delete": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.navigation.items_get": {},
  "dashboard.navigation.items_list": {},
  "dashboard.navigation.items_move": { revision: "required" },
  "dashboard.navigation.items_move_options": {},
  "dashboard.navigation.items_search": {},
  "dashboard.navigation.items_update": { revision: "required" },
  "dashboard.navigation.menus_create": {},
  "dashboard.navigation.menus_get": {},
  "dashboard.navigation.menus_list": {},
  "dashboard.navigation.menus_publish": { revision: "required" },
  "dashboard.navigation.menus_restore": { revision: "required" },
  "dashboard.navigation.menus_rollback": { revision: "required" },
  "dashboard.navigation.menus_trash": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.navigation.menus_update": { revision: "required" },
  "dashboard.navigation.placements_list": {},
  "dashboard.navigation.placements_manifest": {},
  // Where a menu shows stays the merchant's choice: no app, first-party included,
  // places one (write_navigation reaches menus only; agents ignore the tier).
  "dashboard.navigation.placements_save": { stability: "internal", revision: "required" },
  "dashboard.navigation.products_preview_count": { limits: { response: 16_384 } },
  "dashboard.navigation.publications_list": {},
  "dashboard.navigation.resources_search": {},
  // Theme: commands answer revisions only; whole documents reach agents as a JSON artifact.
  // Translations (MARKETS-DESIGN D9): a resource's text in a store language
  // and market; machine translation through an app's provider fills, never saves.
  "dashboard.translations.delete": { risk: "destructive" },
  "dashboard.translations.get": {},
  "dashboard.translations.list": {},
  "dashboard.translations.machine_translate": { openWorld: true },
  "dashboard.translations.providers": {},
  "dashboard.translations.save": {},
  "dashboard.theme.editor_get": {
    exposure: "excluded",
    reason: "The editor's opening bundle (both documents, image previews, app surfaces); agents read workspace_get and document_get.",
  },
  "dashboard.theme.workspace_get": { limits: { response: 16_384 } },
  "dashboard.theme.document_get": {
    batch: "forbidden",
    artifact: { mediaTypes: ["application/json"], disposition: "inline", filenamePolicy: "content-disposition", maxArtifactBytes: 1024 * 1024, delivery: "authenticated-handle" },
  },
  "dashboard.theme.versions_list": { limits: { request: 16_384, response: 65_536 } },
  "dashboard.theme.draft_save": { revision: "required", limits: { response: 4096 } },
  "dashboard.theme.page_draft_update": { revision: "required", limits: { response: 4096 } },
  "dashboard.theme.version_restore": { revision: "required", limits: { response: 4096 } },
  "dashboard.theme.draft_discard": { risk: "destructive", revision: "required", limits: { response: 4096 } },
  "dashboard.theme.preview_session_create": {
    exposure: "continuation",
    risk: "read",
    transport: "continuation",
    limits: { request: 65_536, response: 8_192 },
    sensitive: true,
    continuation: {
      method: "POST",
      urlJsonPointer: "/data/continuation/url",
      fieldsJsonPointer: "/data/continuation/fields",
      sensitiveFields: ["continuationCode"],
    },
  },
  // No app publishes the theme: write_themes changes the draft only, so even a
  // bundled first-party app holding settings.theme.edit cannot call this (agents ignore the tier).
  "dashboard.theme.publish": { stability: "internal", revision: "required", limits: { response: 4096 } },
  // Builder: restore points (the draft before a restore or discard) and drafted sections.
  "dashboard.theme.draft_snapshots_list": { limits: { response: 16_384 } },
  "dashboard.theme.draft_snapshot_restore": { revision: "required", limits: { response: 4096 } },
  // An agent drafts sections itself (draft_sections); the merchant's AI app is reachable too.
  "dashboard.theme.ai_providers_list": {},
  "dashboard.theme.ai_draft_create": { openWorld: true, limits: { response: 65_536 } },
  "dashboard.theme.draft_sections": { revision: "required", limits: { request: 65_536, response: 4096 } },
} satisfies Record<string, OperationRegistryEntry>;
