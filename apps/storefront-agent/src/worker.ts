import { createStorefrontAgentWorker } from "@scalius/agent-runtime/storefront";
import {
  STOREFRONT_CONVERSATION_POLICY,
  ConversationDurableObject,
} from "@scalius/agent-runtime/conversation";

export class StorefrontConversationDurableObject extends ConversationDurableObject<Env> {
  constructor(context: DurableObjectState, env: Env) {
    super(context, env, STOREFRONT_CONVERSATION_POLICY);
  }
}

export default createStorefrontAgentWorker() satisfies ExportedHandler<Env>;
