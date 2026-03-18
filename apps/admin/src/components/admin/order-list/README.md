# Order List Components

Admin order list page: filterable, sortable, paginated table with bulk actions, inline status updates, shipment status tracking, date range filtering, and CSV export.

## Component Tree

```
OrderListContainer (main orchestrator)
├── OrderListToolbar
│   ├── Search input (debounced)
│   ├── Status filter tabs
│   ├── DateRangePickerWithPresets
│   ├── Payment status / method / fulfillment dropdowns
│   ├── Bulk action buttons (delete, ship)
│   ├── Export CSV button
│   ├── Refresh / toggle trash buttons
│   └── Shipment refresh all button
├── OrderTable
│   ├── OrderTableRow (per order)
│   │   ├── Checkbox (supports shift-click range selection)
│   │   ├── Order ID link
│   │   ├── Customer name + phone
│   │   ├── OrderItemsPopover (hover to see items)
│   │   ├── Total amount
│   │   ├── OrderStatusSelector (inline status change)
│   │   ├── ShipmentStatusIndicator (latest shipment)
│   │   ├── FraudCheckIndicator
│   │   ├── Relative timestamp
│   │   └── Action menu (edit, delete, restore)
│   └── OrderMobileCard (responsive card for mobile)
├── OrderListPagination
│   ├── Page selector
│   └── Rows per page selector
├── DeleteOrderDialog
│   └── Confirms single or bulk delete (soft or permanent)
└── BulkShipDialog
    └── Provider selection for bulk shipment creation
```

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel export: `OrderListContainer` as `OrderList` |
| `OrderListContainer.tsx` | Main component. Wires toolbar/table/pagination/dialogs. Manages state via `useOrderListState` and API calls via `useOrderListApi`. |
| `OrderListToolbar.tsx` | Search, status tabs, date range, filter dropdowns, bulk action buttons, CSV export, refresh |
| `OrderTable.tsx` | Desktop table with sortable headers, select-all checkbox, shipment column |
| `OrderTableRow.tsx` | Single order row with inline status selector, shipment indicator, action menu |
| `OrderMobileCard.tsx` | Mobile-responsive card layout for each order |
| `OrderListPagination.tsx` | Page navigation and rows-per-page selector |
| `OrderStatusSelector.tsx` | Inline dropdown for changing order status with confirmation |
| `DeleteOrderDialog.tsx` | Confirmation dialog for single/bulk delete. Handles both soft delete and permanent delete (trash view). |
| `BulkShipDialog.tsx` | Dialog for selecting delivery provider and shipping multiple orders |
| `DateRangePickerWithPresets.tsx` | Date range picker with preset options (today, last 7 days, etc.) |
| `FraudCheckIndicator.tsx` | Visual indicator for suspicious order patterns |
| `OrderItemsPopover.tsx` | Hover popover showing order item details |
| `hooks/useOrderListState.ts` | State management: orders, pagination, search, sort, selection, filters, loading flags |
| `hooks/useOrderListApi.ts` | API calls: fetch orders, update status, delete, restore, bulk ship, export CSV, refresh shipments |

## Features

- **FTS5 search**: Server-side full-text search across order fields
- **Status filtering**: Tabs for each order status + "all" tab
- **Date range filtering**: With presets (today, yesterday, last 7/30/90 days, this month, last month)
- **Payment/fulfillment filters**: Dropdown filters for payment status, payment method, fulfillment status
- **Sort**: Clickable column headers for customerName, totalAmount, status, createdAt, updatedAt
- **Shift-click selection**: Range selection for bulk operations
- **Inline status update**: Change order status directly from the table row
- **Shipment status**: Shows latest shipment status with refresh button per row
- **Bulk refresh shipments**: Refresh all visible shipments in one action
- **CSV export**: Downloads current filtered view as CSV
- **Trash view**: Toggle between active orders and soft-deleted (trashed) orders
- **Responsive**: Desktop table view + mobile card view

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

- **`useOrderListState`**: Pure state (no API calls). Manages `displayOrders`, `currentPagination`, `searchQuery`, `sort`, `selectedOrders`, `activeStatus`, filter dropdowns, loading flags, dialog visibility.
- **`useOrderListApi`**: API interaction layer. Provides `fetchOrders`, `handleStatusUpdate`, `performDelete`, `handleRestore`, `handleBulkShipmentSubmit`, `handleExportCSV`, `handleRefreshAllShipments`. Updates state via the state hook's setters.

## Dependencies

- `@scalius/core/modules/orders` -- `OrderListItem` type
- `@/lib/client/navigate` -- `navigateTo()` for client-side navigation
- `@/hooks/use-shipment-status` -- `useShipmentStatus` for shipment refresh
- `react-day-picker` -- `DateRange` type for date filtering
- `sonner` -- toast notifications
- `lucide-react` -- icons
- `@/components/ui/*` -- shadcn/ui primitives
