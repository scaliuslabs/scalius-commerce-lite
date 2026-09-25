// The context rail's card for what a thread is about, by its subject type.
// Order and store threads have none: the rail's own customer, order and
// requests sections cover them. Each card renders its own rail <section>.
import type { StaffThread } from "~/lib/api-query-options/inbox";
import { ReviewContext } from "./review";
import { WarrantyClaimContext } from "./warranty-claim";

export function SubjectContext({ thread }: { thread: StaffThread }) {
  switch (thread.subjectType) {
    case "review":
      return <ReviewContext thread={thread} />;
    case "warranty_claim":
      return <WarrantyClaimContext thread={thread} />;
    default:
      return null;
  }
}
