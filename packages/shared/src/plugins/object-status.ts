// The statuses an app object's record may hold. A leaf with no imports: the
// event contracts name these, and the dashboard pages that read an event topic
// must not download the object schemas (and the handle spelling tables) to do so.
export const OBJECT_STATUSES = ["active", "draft", "published"] as const;
export type ObjectStatus = (typeof OBJECT_STATUSES)[number];
