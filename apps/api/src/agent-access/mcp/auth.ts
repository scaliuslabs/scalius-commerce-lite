import type { AgentOAuthProps, AgentResource } from "../types";

export function isAgentOAuthProps(value: unknown): value is AgentOAuthProps {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const props = value as Partial<AgentOAuthProps>;
  return (
    /^agr_[A-Za-z0-9_-]{20}$/.test(props.grantId ?? "") &&
    (props.credentialId === undefined || /^agc_[A-Za-z0-9_-]{20}$/.test(props.credentialId)) &&
    typeof props.ownerUserId === "string" &&
    props.ownerUserId.length > 0 &&
    props.ownerUserId.length <= 160 &&
    /^[\x21-\x7E]+$/.test(props.ownerUserId) &&
    (props.resource === "dashboard" || props.resource === "storefront") &&
    Array.isArray(props.permissions) &&
    props.permissions.every((permission) => typeof permission === "string") &&
    ["read", "write", "destructive", "financial", "security"].includes(
      props.riskCeiling ?? "",
    ) &&
    Array.isArray(props.audience) &&
    props.audience.length === 1 &&
    typeof props.audience[0] === "string"
  );
}

export function isAgentOAuthPropsForResource(
  value: unknown,
  resource: AgentResource,
  canonicalApiOrigin: string,
): value is AgentOAuthProps {
  if (!isAgentOAuthProps(value) || value.resource !== resource) return false;
  let expectedAudience: string;
  try {
    expectedAudience = `${new URL(canonicalApiOrigin).origin}/api/v1/mcp/${resource}`;
  } catch {
    return false;
  }
  return value.audience[0] === expectedAudience;
}
