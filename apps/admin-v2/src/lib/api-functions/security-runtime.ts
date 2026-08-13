import { createAdminApiFunction as createServerFn } from "../admin-api-function";
import { apiGet } from "../api";

export type InheritedSecuritySourceKind =
  | "storefront"
  | "api"
  | "dashboard"
  | "media";

export interface InheritedSecuritySource {
  key: string;
  label: string;
  kind: InheritedSecuritySourceKind;
  source: string | null;
  consequence: string;
}

export const getInheritedSecuritySources = createServerFn({
  method: "GET",
}).handler(async (): Promise<InheritedSecuritySource[]> =>
  apiGet<InheritedSecuritySource[]>("/settings/security/runtime-sources"),
);
