// Text search on every provider: D1's FTS5 tables, or the search index of
// Turso and PostgreSQL, with the same matches and ranks. Domain search lives
// with its domain (catalogue search and the site search in modules/catalog).
export {
  isFts5SearchEnabled,
  sanitizeFtsQuery,
  sanitizeSearchTokens,
  searchKeyColumn,
  searchKeys,
  searchMatch,
  searchPrefixKeys,
  searchRank,
  type SearchSource,
} from "./text-search";
