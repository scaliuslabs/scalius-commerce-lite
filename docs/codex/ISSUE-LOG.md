# GitHub Issue Log

Last reviewed: 2026-05-11

## Verified Fixes

| Issue | Title | Commit | Verification |
| --- | --- | --- | --- |
| #32 | Phone Search Logic Error | `428dab1` | Production API returned the expected order set for `01774452222` and `+8801774452222`. Chrome production dashboard showed `9 orders` for `01774452222`; visible rows all used `+880 1774 452222`. |

## Implemented, Needs Browser Verification

These changes were already committed in `aa05893` before the current per-issue loop. Verify each production flow before treating it as done.

| Issue | Title | Implementation Status |
| --- | --- | --- |
| #34 | "Active" status showing for collections in Trash. | Trash row status display adjusted to `Trashed`. |
| #33 | Trashed Widgets Displaying "Active" Status | Trash row status display adjusted to `Trashed`. |
| #31 | "Deactivate script" is not working | Analytics toggle sends the inverse active state. |
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
| #16 | Media Library "Videos" filter is not working correctly. | Admin media filtering. |
| #15 | Price Filter Slider capped at ৳50,000 (Cannot set higher value) | Storefront filter range. |
| #14 | Validation Error Displaying Raw JSON Code on Checkout. | Checkout error presentation. |
| #13 | Issue with Page Content Display for "Combo Offers Page" | Storefront page/rich content rendering. |
