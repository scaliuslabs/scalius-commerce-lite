/** Routes that bypass admin middleware (non-admin API proxied to the API worker, Better Auth). */
export function isPublicRoute(pathname: string): boolean {
  return (
    (pathname.startsWith("/api/v1") && !pathname.startsWith("/api/v1/admin")) ||
    pathname.startsWith("/api/auth/")
  );
}
