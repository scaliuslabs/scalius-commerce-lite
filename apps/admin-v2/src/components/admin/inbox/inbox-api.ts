// Inbox writes: replies and notes, thread updates, read marks and the image
// upload. The SDK carries JSON; image uploads stay on a same-origin multipart
// fetch (the SDK transport sends text bodies only, as the media library does).
// Reads live in lib/api-query-options/inbox.ts, which loads with the shell.
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import {
  patchApiV1AdminConversationsById,
  postApiV1AdminConversationsByIdMessages,
  postApiV1AdminConversationsByIdRead,
  postApiV1AdminConversationsOrderByOrderIdMessages,
} from "@scalius/api-client/sdk";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { apiData } from "~/lib/api";
import { inboxKeys, type StaffThread } from "~/lib/api-query-options/inbox";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";

/** Where an attachment image loads from (same origin, session cookie, never cached). */
export function attachmentUrl(conversationId: string, attachmentId: string): string {
  return withDashboardBasePath(
    `/api/v1/admin/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
}

export function newRequestKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function putThread(queryClient: QueryClient, thread: StaffThread) {
  queryClient.setQueryData(inboxKeys.thread(thread.id), thread);
  if (thread.orderId) queryClient.setQueryData(inboxKeys.order(thread.orderId), thread);
  void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
  void queryClient.invalidateQueries({ queryKey: inboxKeys.summary() });
}

export interface PostInput {
  body: string;
  visibility: "public" | "internal";
  requestKey: string;
  attachmentIds?: string[];
}

/** Reply or note on a thread, or on an order (which starts its thread when needed). */
export function usePostMessage(target: { conversationId?: string | null; orderId?: string | null }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PostInput) => {
      if (target.conversationId) {
        return (await apiData(postApiV1AdminConversationsByIdMessages({ path: { id: target.conversationId }, body: input }))).conversation;
      }
      if (target.orderId) {
        return (await apiData(postApiV1AdminConversationsOrderByOrderIdMessages({ path: { orderId: target.orderId }, body: input }))).conversation;
      }
      throw new Error("No conversation to post to");
    },
    onSuccess: (thread) => putThread(queryClient, thread),
  });
}

export function useUpdateThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; version: number; status?: "open" | "pending" | "closed"; assigneeUserId?: string | null }) => {
      const { id, ...body } = input;
      return (await apiData(patchApiV1AdminConversationsById({ path: { id }, body }))).conversation;
    },
    onSuccess: (thread) => putThread(queryClient, thread),
    onError: (error, input) => {
      if (error instanceof AdminApiResponseError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.thread(input.id) });
      }
    },
  });
}

/** Marks a thread read for staff once per new last message. */
export function useMarkRead() {
  const queryClient = useQueryClient();
  const marked = useRef(new Map<string, number>());
  return useCallback((thread: Pick<StaffThread, "id" | "lastSeq" | "unread">) => {
    if (thread.unread <= 0 || (marked.current.get(thread.id) ?? 0) >= thread.lastSeq) return;
    marked.current.set(thread.id, thread.lastSeq);
    void apiData(postApiV1AdminConversationsByIdRead({ path: { id: thread.id }, body: { seq: thread.lastSeq } }))
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
        void queryClient.invalidateQueries({ queryKey: inboxKeys.summary() });
      })
      .catch(() => marked.current.delete(thread.id));
  }, [queryClient]);
}

export interface UploadedImage {
  attachmentId: string;
  conversationId: string;
  width: number | null;
  height: number | null;
}

/** Uploads one image for a thread (or an order's thread); the server re-encodes it to WebP. */
export async function uploadConversationImage(
  file: File,
  target: { conversationId?: string | null; orderId?: string | null },
): Promise<UploadedImage> {
  const form = new FormData();
  form.set("file", file);
  if (target.conversationId) form.set("conversationId", target.conversationId);
  else if (target.orderId) form.set("orderId", target.orderId);
  const response = await fetch(withDashboardBasePath("/api/v1/admin/conversations/attachments"), {
    method: "POST",
    body: form,
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as
    | { success?: boolean; data?: UploadedImage; error?: { message?: string; code?: string } }
    | null;
  if (!response.ok || !body?.data) {
    throw new AdminApiResponseError(body?.error?.message ?? "Upload failed", response.status || 502, body?.error?.code);
  }
  return body.data;
}
