// Digital domain: downloadable files in private R2, licence-key pools that are
// the variant's stock, entitlements and cookie-bound download tickets
// (Wave B design §3).
export * from "./browser";
export type { LineExtrasInput } from "../../utils/line-extras";
export { digitalDeliverableSql } from "./deliverable";
export { countBuyerDownloads, listLineDeliveries } from "./extras";
export { sweepDigitalUploads } from "./uploads";
export {
    completeDigitalAssetUpload,
    createDigitalAsset,
    deleteDigitalAsset,
    expectedDigitalPartBytes,
    getDigitalAsset,
    getDigitalAssetUpload,
    listProductDigitalAssets,
    startDigitalAssetUpload,
    updateDigitalAsset,
    uploadDigitalAssetPart,
} from "./assets";
export type {
    CreateDigitalAssetInput,
    DigitalAssetStatus,
    DigitalAssetView,
    DigitalUploadSession,
    UpdateDigitalAssetInput,
} from "./assets";
export { importLicenceKeys, listLicenceKeys, revokeLicenceKeys } from "./licence-keys";
export type { ImportLicenceKeysResult, LicenceKeyAdminView } from "./licence-keys";
export {
    listBuyerDownloads,
    mintDownloadTicket,
    openDownloadTicket,
    revealLicenceKey,
} from "./downloads";
export type {
    BuyerDigitalLine,
    BuyerDownloadFile,
    BuyerLicenceKey,
    DigitalBuyerAccess,
    DownloadObject,
    DownloadTicket,
} from "./downloads";
export {
    countOrderDigitalEntitlements,
    resetDigitalEntitlement,
    resolveDigitalDeliveryContent,
    revokeDigitalEntitlement,
} from "./entitlements";
export type { DigitalDeliveryContent } from "./entitlements";
export { DIGITAL_KEYS_EXHAUSTED, planDigitalDelivery } from "./fulfiller";
export type { DigitalDeliveryLine, DigitalDeliveryPlan, DigitalShortPool } from "./fulfiller";
export { LICENCE_KEYS_UNAVAILABLE } from "./secrets";
