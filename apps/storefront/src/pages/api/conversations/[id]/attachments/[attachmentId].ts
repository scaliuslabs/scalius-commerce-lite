// One private image of an account conversation, served same-origin so the
// session cookie authorizes it. Never cached, never sniffed.
import type { APIRoute } from "astro";
import { proxyConversationAttachment } from "@/lib/account-inbox-server";
import { isConversationId } from "@/lib/account-inbox";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const conversationId = isConversationId(params.id) ? params.id : "";
  return proxyConversationAttachment(
    request,
    { kind: "thread", conversationId },
    conversationId ? params.attachmentId ?? "" : "",
  );
};
