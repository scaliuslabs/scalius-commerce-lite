export const ENTRY_QUERY: "__gallery_entry";
export function cleanGalleryUrl(value: string | URL): URL;
export function galleryContextId(url: URL, referer: string | undefined, hasEntry: (id: string) => boolean): string | null;
export function galleryNavigationRedirect(url: URL, entryId: string | null, headers: Record<string, string | string[] | undefined>, page: boolean): string | null;
export function galleryHistoryScript(entryId: string): string;
