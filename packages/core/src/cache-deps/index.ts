/**
 * Dependency recording for the dependency-validated public cache (DVC).
 * See README.md in this directory for how readers declare dependencies.
 */
export { deps } from "./deps";
export {
  activeDependencyScope,
  CacheDepCoverageError,
  withDependencyScope,
  type CacheDependencies,
  type DependencyScopeOptions,
  type DependencyScopeResult,
} from "./scope";
export {
  CACHE_DEP_SOFT_TABLES,
  coarseKeysForKind,
  resolveCacheDependencies,
  type CacheDepResolution,
  type CacheDepResolveInput,
} from "./resolve";
