import type { ConversationObjectNamespace } from "./conversation/router";

export interface AdminAgentRuntimeEnv {
  API: Fetcher;
  ADMIN_CONVERSATIONS?: ConversationObjectNamespace;
  AGENT_NAME?: string;
  AGENT_VERSION?: string;
}

export interface StorefrontAgentRuntimeEnv {
  API: Fetcher;
  STOREFRONT_CONVERSATIONS?: ConversationObjectNamespace;
  STOREFRONT_URL?: string;
  AGENT_PROFILE_URL?: string;
  AGENT_NAME?: string;
  AGENT_VERSION?: string;
}
