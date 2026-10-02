// Test-only: walks a keyset-paged list page by page. Never import from Worker code.
import type { PageInfo } from "@scalius/shared/pagination";

export interface WalkedPage {
    ids: string[];
    pageInfo: PageInfo;
    /** The page's zero-based first-row index when the list reports one. */
    offset: number | null;
}

export type FetchPage = (cursor: { after?: string; before?: string }) => Promise<WalkedPage>;

/** Pages from the top with `after` until `hasNextPage` is false. */
export async function walkForward(fetchPage: FetchPage, maxPages = 500): Promise<WalkedPage[]> {
    const pages: WalkedPage[] = [];
    let cursor: { after?: string } = {};
    for (let index = 0; index < maxPages; index += 1) {
        const page = await fetchPage(cursor);
        pages.push(page);
        if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) return pages;
        cursor = { after: page.pageInfo.endCursor };
    }
    throw new Error(`The list did not end within ${maxPages} pages.`);
}

/** Pages from `last` back to the top with `before`, in the order they are read (bottom page first). */
export async function walkBackward(fetchPage: FetchPage, last: WalkedPage, maxPages = 500): Promise<WalkedPage[]> {
    const pages: WalkedPage[] = [last];
    let page = last;
    for (let index = 0; index < maxPages; index += 1) {
        if (!page.pageInfo.hasPreviousPage || !page.pageInfo.startCursor) return pages;
        page = await fetchPage({ before: page.pageInfo.startCursor });
        pages.push(page);
    }
    throw new Error(`The list did not start within ${maxPages} pages.`);
}

/** Compares two values the way SQLite's BINARY collation and NULLs-first order do. */
export function compareSqliteValues(left: number | string | null, right: number | string | null): number {
    if (left === right) return 0;
    if (left === null) return -1;
    if (right === null) return 1;
    return left < right ? -1 : 1;
}
