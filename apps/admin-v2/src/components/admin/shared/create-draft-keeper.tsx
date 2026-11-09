import { useCreateDraft, type CreateDraftOptions } from "./use-create-draft";

/** `useCreateDraft` as a component, so a form can load it on demand (`LazyCreateDraft`). Renders the offer outside a save scope. */
export function CreateDraftKeeper<T>(props: CreateDraftOptions<T>) {
  return useCreateDraft(props).offer;
}
