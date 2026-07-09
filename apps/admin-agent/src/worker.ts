import { createAdminAgentWorker } from "@scalius/agent-runtime/admin";
import {
  ADMIN_CONVERSATION_POLICY,
  ConversationDurableObject,
} from "@scalius/agent-runtime/conversation";

export class AdminConversationDurableObject extends ConversationDurableObject<Env> {
  constructor(context: DurableObjectState, env: Env) {
    super(context, env, ADMIN_CONVERSATION_POLICY);
  }
}

export default createAdminAgentWorker() satisfies ExportedHandler<Env>;
