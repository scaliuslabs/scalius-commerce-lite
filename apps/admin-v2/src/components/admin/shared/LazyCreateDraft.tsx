import { lazy, Suspense } from "react";
import type { CreateDraftOptions } from "./use-create-draft";

// A form shared by its create and edit pages keeps drafts only when creating:
// the edit page never loads the draft code, and the create page loads it just
// after its first render (the kept draft is offered a moment later).
const CreateDraftKeeper = lazy(() => import("./create-draft-keeper").then((module) => ({ default: module.CreateDraftKeeper })));

/** `useCreateDraft` loaded on demand; nothing at all while `enabled` is false. */
export function LazyCreateDraft<T>(props: CreateDraftOptions<T>) {
  if (!props.enabled) return null;
  return (
    <Suspense fallback={null}>
      {/* lazy() drops the generic; the keeper hands the same T back to `restore`. */}
      <CreateDraftKeeper {...(props as unknown as CreateDraftOptions<unknown>)} />
    </Suspense>
  );
}
