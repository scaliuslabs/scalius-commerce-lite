// Media references domain: how other records point at stored files — the
// published object key and URL projection, and the guard that refuses a
// reference to a file being deleted. It depends on no other domain, so every
// writer that embeds a file (settings, categories, pages, staff) can use it.
export * from "./presentation";
export * from "./reference-guard";
