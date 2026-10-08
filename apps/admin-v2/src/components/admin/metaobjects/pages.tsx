// The six Content types screens behind one lazy module: the routes load this
// file with their page, so the dashboard's download plan gains one chunk for
// the whole area instead of one per route.
import { useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { metaobjectDefinitionQueryOptions, metaobjectEntryQueryOptions } from "~/lib/api-query-options/metaobjects";
import { MetaobjectEntriesList } from "./MetaobjectEntriesList";
import { MetaobjectEntryForm } from "./MetaobjectEntryForm";
import { MetaobjectTypeForm } from "./MetaobjectTypeForm";
import { MetaobjectTypesList } from "./MetaobjectTypesList";

/** Content types. */
export function TypesPage() {
  return <MetaobjectTypesList />;
}

/** Create content type. */
export function NewTypePage() {
  return <MetaobjectTypeForm definition={null} />;
}

/** One type's entries. */
export function EntriesPage() {
  const { definitionId } = useParams({ strict: false }) as { definitionId: string };
  return <MetaobjectEntriesList key={definitionId} definitionId={definitionId} />;
}

/** One type's fields and settings. */
export function TypePage() {
  const { definitionId } = useParams({ strict: false }) as { definitionId: string };
  const { data } = useSuspenseQuery(metaobjectDefinitionQueryOptions(definitionId));
  // Keyed by the type, not its revision: a save moves the revision and must not remount the page mid-save.
  return <MetaobjectTypeForm key={data.id} definition={data} />;
}

/** Add entry. */
export function NewEntryPage() {
  const { definitionId } = useParams({ strict: false }) as { definitionId: string };
  const { data } = useSuspenseQuery(metaobjectDefinitionQueryOptions(definitionId));
  return <MetaobjectEntryForm key={data.id} definition={data} entry={null} />;
}

/** One entry. */
export function EntryPage() {
  const { definitionId, entryId } = useParams({ strict: false }) as { definitionId: string; entryId: string };
  const definition = useSuspenseQuery(metaobjectDefinitionQueryOptions(definitionId));
  const entry = useSuspenseQuery(metaobjectEntryQueryOptions(definitionId, entryId));
  // Keyed by the entry, not its revision: a save moves the revision and must not remount the page mid-save.
  return <MetaobjectEntryForm key={entry.data.id} definition={definition.data} entry={entry.data} />;
}
