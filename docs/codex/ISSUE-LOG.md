# GitHub Issue Log

Last reviewed: 2026-05-11

## Verified Fixes

| Issue | Title | Commit | Verification |
| --- | --- | --- | --- |
| #32 | Phone Search Logic Error | `428dab1` | Production API returned the expected order set for `01774452222` and `+8801774452222`. Chrome production dashboard showed `9 orders` for `01774452222`; visible rows all used `+880 1774 452222`. |
| #34 | "Active" status showing for collections in Trash. | `aa05893` | Isolated Google Chrome verification opened the production Collections Trash page and showed the settled empty-trash state with no `Active` status text or status switches. A remote D1 read confirmed there are currently zero trashed collections in production, so a real trashed row could not be observed without creating production test data. The deployed column code renders trashed collection rows as `Trashed` and hides the switch. |
| #31 | "Deactivate script" is not working | `aa05893` | Isolated Google Chrome verification opened the production Analytics Scripts page. The `Lorem ipsum` row started `Active` with a Deactivate action, changed to `Inactive` with an Activate action after clicking Deactivate, then restored to `Active` after clicking Activate. A remote D1 read confirmed the script ended at `is_active = 1`. |
| #33 | Trashed Widgets Displaying "Active" Status | `aa05893` | Chrome production dashboard at `/admin/widgets/trash` showed a real trashed widget row with status `Trashed`, not `Active`. |
| #16 | Media Library "Videos" filter is not working correctly. | `cb9390f` | Production API returned 89 total media files and 0 `mimeType=video` files. Chrome production dashboard Videos filter settled on `No Files Found` instead of showing image files. Legacy `type=video` also returned 0 for compatibility. |
| #15 | Price Filter Slider capped at ৳50,000 (Cannot set higher value) | `1312766` | Local and production browser checks confirmed `/search` keeps `maxPrice=200000` after submit and reload. The hydrated max price control shows `200000`, and the slider label shows `৳200K`. Storefront version `e61c6d4a-bb63-4c68-bcd9-46880d869fea` was verified after deploy. |
| #14 | Validation Error Displaying Raw JSON Code on Checkout. | `03cfbe8` | Local and production proxy checks return `Address must be at least 10 characters` for the short-address payload. Production browser checkout flow (Fish -> cart -> `rajshahi` address -> COD) shows only the readable message and no raw `too_small`/`origin`/`minimum` JSON fragments. Storefront version `06c013a9-5448-46fa-a959-08cae6ef2a3a` was verified after deploy. |
| #13 | Issue with Page Content Display for "Combo Offers Page" | `317b48a` | Local browser verification used a local D1 fixture copied from the production combo-offer page/widget and confirmed the landing hero renders without the generic CMS title, Back to Home link, or raw widget wrapper tags. Production browser verification at `/combo-offer` after deploy confirmed the same settled DOM state. Storefront version `75164a7a-78dc-4e23-a4b3-c749cebf9f44` was verified after deploy. |

## Implemented, Needs Browser Verification

These changes were already committed in `aa05893` before the current per-issue loop. Verify each production flow before treating it as done.

| Issue | Title | Implementation Status |
| --- | --- | --- |
| #30 | "Delete Permanently" action triggers "Widget not found" error | Widget trash permanent delete uses the permanent-delete mutation. |
| #27 | Broken "View" Action for Trashed Items in Page Trash | Page trash action no longer renders the broken view action. |
| #25 | API 404 Error on Individual Cache Clear Actions | Cache clear posts to `/cache/clear-group` with a `groups` array. |
| #22 | Sorting Functionality Completely Unresponsive in Inventory Module | Inventory route/service accepts sort/order and sorts by supported fields. |
| #20 | "View" Action is Unresponsive in Category Trash | Category trash action no longer renders the broken view action. |
| #17 | Deleted Products Retain "Active" Status in Trash | Product trash status label adjusted. The issue body also mentions WYSIWYG image rendering, which still needs separate investigation. |

## Open Work Queue

| Issue | Title | Notes |
| --- | --- | --- |
| #29 | Fixed desktop-width sidebar fails to collapse/reflow in Mobile Viewport | Mobile admin layout issue. |
| #28 | High-Severity Contrast & Background-Color Regression on Mobile Sidebar Overlay | Mobile sidebar visual/accessibility issue. |
| #26 | "Edit" Button Triggers Immediate Save Instead of Enabling Inputs | Fraud checker settings edit/save behavior. |
| #24 | Layout Overflow & Missing Padding | Storefront mobile layout. |
| #23 | Content Featured Image not displaying on Storefront | Storefront content/page rendering. |
