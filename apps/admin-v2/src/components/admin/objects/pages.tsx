// The six Content types screens behind one lazy module: the routes load this
// file with their page, so the dashboard's download plan gains one chunk for
// the whole area instead of one per route.
import { useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { objectTypeQueryOptions, objectRecordQueryOptions } from "~/lib/api-query-options/objects";
import { ObjectRecordsList } from "./ObjectRecordsList";
import { ObjectRecordForm } from "./ObjectRecordForm";
import { ObjectTypeForm } from "./ObjectTypeForm";
import { ObjectTypesList } from "./ObjectTypesList";

/** Content types. */
export function TypesPage() {
  return <ObjectTypesList />;
}

/** Create content type. */
export function NewTypePage() {
  return <ObjectTypeForm definition={null} />;
}

/** One type's entries. */
export function EntriesPage() {
  const { type } = useParams({ strict: false }) as { type: string };
  return <ObjectRecordsList key={type} type={type} />;
}

/** One type's fields and settings. */
export function TypePage() {
  const { type } = useParams({ strict: false }) as { type: string };
  const { data } = useSuspenseQuery(objectTypeQueryOptions(type));
  // Keyed by the type, not its revision: a save moves the revision and must not remount the page mid-save.
  return <ObjectTypeForm key={data.id} definition={data} />;
}

/** Add entry. */
export function NewEntryPage() {
  const { type } = useParams({ strict: false }) as { type: string };
  const { data } = useSuspenseQuery(objectTypeQueryOptions(type));
  return <ObjectRecordForm key={data.id} definition={data} entry={null} />;
}

/** One entry. */
export function EntryPage() {
  const { type, recordId } = useParams({ strict: false }) as { type: string; recordId: string };
  const definition = useSuspenseQuery(objectTypeQueryOptions(type));
  const entry = useSuspenseQuery(objectRecordQueryOptions(type, recordId));
  // Keyed by the entry, not its revision: a save moves the revision and must not remount the page mid-save.
  return <ObjectRecordForm key={entry.data.id} definition={definition.data} entry={entry.data} />;
}
