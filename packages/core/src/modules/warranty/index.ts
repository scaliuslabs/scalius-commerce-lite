// Warranty domain: reusable warranty policies with immutable revisions, the
// per-fulfilment-line warranty records and claims as conversation-backed
// records (Wave B design §5). Stubs until B5 fills them.
export * from "./browser";
export type { LineExtrasInput } from "../../utils/line-extras";
export { countActiveBuyerWarranties, listLineWarranties } from "./extras";
