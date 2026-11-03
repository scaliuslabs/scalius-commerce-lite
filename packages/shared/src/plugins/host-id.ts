// Element ids the storefront keeps for itself. The plugin HTML sanitizer
// (`html.ts`) refuses them in app markup, even for an app whose own id
// prefix (`<app name>-`) they would match, so an app element can never take
// the place of a host one (the buy form, which its parts join with `form=`).
// Dependency-free: browser code reads it without the sanitizer.

export const HOST_ID_PREFIX = "sx-";
