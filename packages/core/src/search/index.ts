// Full-text search primitives over the SQLite FTS5 tables (D1, TursoDB):
// query sanitizing and the MATCH condition. Domain search lives with its
// domain (catalogue search and the site search in modules/catalog).
export { ftsMatch, isFts5SearchEnabled, sanitizeFtsQuery } from "./fts5";
