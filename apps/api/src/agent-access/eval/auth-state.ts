// The OAuth props the MCP handler would have verified for the active grant.
// The eval test file points `getMcpAuthContext` at this object; nothing else
// is mocked, so principal resolution, authorization and confirmation run for
// real against the seeded grant rows.
import type { AgentOAuthProps } from "../types";

export const evalAuth: { props: AgentOAuthProps | null } = { props: null };
