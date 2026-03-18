# Order List Components

Admin order list page: filterable, sortable, paginated table with bulk actions, inline status updates, shipment status tracking, date range filtering, and CSV export.

## Component Tree

```
OrderListContainer (main orchestrator)
├── OrderListToolbar
│   ├── Search input (debounced, "/" keyboard shortcut)
│   ├── Auto-refresh toggle (60s interval, persisted to localStorage)
│   ├── Status filter tabs (all 11 states)
│   ├── DateRangePickerWithPresets
│   ├── Payment status / method / fulfillment dropdowns
│   ├── Bulk action buttons (delete, ship)
│   ├── Export CSV button
│   └── Toggle trash / Add Order buttons
├── OrderTable
│   ├── OrderTableRow (per order, React.memo)
│   │   ├── Checkbox (supports shift-click range selection)
│   │   ├── Customer name link (with order ID tooltip)
│   │   ├── Phone + email + city/zone/area
│   │   ├── OrderItemsPopover (hover to see items)
│   │   ├── Total amount + discount badge + payment status/method badges
│   │   ├── OrderStatusSelector (inline dropdown, all 11 states)
│   │   ├── ShipmentStatusIndicator (latest shipment + tracking link)
│   │   ├── FraudCheckIndicator
│   │   ├── Relative timestamp (with full date tooltip)
│   │   └── Action buttons (view, edit, delete/restore/permanent delete)
│   ├── OrderMobileCard (responsive card, React.memo)
│   └── Refresh all shipments button (in table header)
├── OrderListPagination
│   ├── Page navigation (previous/next)
│   └── Rows per page selector (5, 10, 20, 50, 100)
├── DeleteOrderDialog
│   └── Confirms single or bulk delete (soft or permanent in trash view)
└── BulkShipDialog
    └── Provider selection for bulk shipment creation
```

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel export: `OrderListContainer` as `OrderList` |
| `OrderListContainer.tsx` | Main component. Wires toolbar/table/pagination/dialogs. Manages state via `useOrderListState` and API calls via `useOrderListApi`. |
| `OrderListToolbar.tsx` | Search (debounced 500ms, "/" shortcut, Escape clears), auto-refresh toggle, status tabs (all 11 statuses), date range, payment/fulfillment filter dropdowns, bulk action buttons, CSV export, toggle trash |
| `OrderTable.tsx` | Desktop table with sortable headers (customer, amount, status, date), select-all checkbox, shipment column with refresh-all button |
| `OrderTableRow.tsx` | Single order row with inline status selector, shipment indicator with provider-specific tracking URLs (Pathao/Steadfast), color-coded left border by status, action menu |
| `OrderMobileCard.tsx` | Mobile-responsive card layout with same features as table row |
| `OrderListPagination.tsx` | Page navigation and rows-per-page selector |
| `OrderStatusSelector.tsx` | Inline dropdown for changing order status. Renders all 11 statuses with color-coded pill badges and animated dot indicators. Disabled in trash view. |
| `DeleteOrderDialog.tsx` | Confirmation dialog for single/bulk delete. Handles both soft delete and permanent delete (trash view). |
| `BulkShipDialog.tsx` | Dialog for selecting delivery provider and shipping multiple orders |
| `DateRangePickerWithPresets.tsx` | Date range picker with preset options (today, last 7 days, etc.) |
| `FraudCheckIndicator.tsx` | Visual indicator for suspicious order patterns |
| `OrderItemsPopover.tsx` | Hover popover showing order item details |
| `hooks/useOrderListState.ts` | State management: orders, pagination, search, sort, selection, filters, loading flags |
| `hooks/useOrderListApi.ts` | API calls: fetch orders, update status, delete, restore, bulk ship, export CSV, refresh shipments |

## Features

- **FTS5 search**: Server-side full-text search across order fields (debounced 500ms client-side)
- **Status filtering**: Tabs for all 11 order statuses: pending, processing, confirmed, shipped, delivered, completed, cancelled, refunded, returned, partially_refunded, incomplete
- **Date range filtering**: With presets (today, yesterday, last 7/30/90 days, this month, last month)
- **Payment/fulfillment filters**: Dropdown filters for payment status (unpaid/partial/paid/refunded/failed), payment method (Stripe/SSLCommerz/COD), fulfillment status (unfulfilled/partial/fulfilled)
- **Sort**: Clickable column headers for customerName, totalAmount, status, createdAt, updatedAt
- **Shift-click selection**: Range selection for bulk operations (clears text selection to prevent highlight artifacts)
- **Inline status update**: Change order status directly from the table row via dropdown
- **Shipment status**: Shows latest shipment status with per-row refresh button. Provider-specific tracking URLs for Pathao and Steadfast.
- **Bulk refresh shipments**: Refresh all visible shipments in one action (button in table header)
- **Auto-refresh**: Toggle with 60-second interval, persisted to `localStorage` key `orderlist-auto-refresh`, shows countdown timer
- **CSV export**: Downloads current filtered view as CSV
- **Trash view**: Toggle between active orders and soft-deleted (trashed) orders. Trash view shows restore + permanent delete buttons instead of edit + delete.
- **Responsive**: Desktop table view + mobile card view (hidden/shown via `md:` breakpoint)
- **Keyboard shortcuts**: `/` focuses search, `Escape` clears and blurs search

## Data Flow

1. **Initial load**: Astro page calls `getOrdersIndexData()` loader, which calls `apiGet("/orders")` via service binding
2. **Client hydration**: `OrderListContainer` receives SSR'd orders + pagination as props
3. **Client-side navigation**: All subsequent fetches use `useOrderListApi.fetchOrders()` which calls `/api/v1/admin/orders` via the Vite proxy
4. **Status updates**: `handleStatusUpdate()` calls `PUT /api/v1/admin/orders/:id/status`, then re-fetches the order list
5. **Delete**: Calls `POST /api/v1/admin/orders/bulk-delete` for both single and bulk operations
6. **Restore**: Calls `POST /api/v1/admin/orders/:id/restore`
7. **Bulk ship**: Calls `POST /api/v1/admin/orders/bulk-ship`

## State Management

State is split into two hooks:

- **`useOrderListState`**: Pure state (no API calls). Manages `displayOrders`, `currentPagination`, `searchQuery`, `sort`, `selectedOrders`, `lastSelectedId`, `activeStatus`, `paymentStatus`, `paymentMethod`, `fulfillmentStatus`, `shipmentStatuses`, `dateRange`, `updatingStatusIds`, loading/dialog flags.
- **`useOrderListApi`**: API interaction layer. Provides `fetchOrders`, `handleStatusUpdate`, `performDelete`, `handleRestore`, `handleBulkShipmentSubmit`, `handleExportCSV`, `handleRefreshAllShipments`. Updates state via the state hook's setters.

## Dependencies

- `@scalius/core/modules/orders` -- `OrderListItem` type
- `@/lib/client/navigate` -- `navigateTo()` for client-side navigation
- `@/hooks/use-shipment-status` -- shipment refresh logic
- `@/hooks/useCurrency` -- currency symbol for price formatting
- `react-day-picker` -- `DateRange` type for date filtering
- `sonner` -- toast notifications
- `lucide-react` -- icons
- `@/components/ui/*` -- shadcn/ui primitives
- `@/components/admin/ShipmentStatusIndicator` -- shipment status display with refresh
