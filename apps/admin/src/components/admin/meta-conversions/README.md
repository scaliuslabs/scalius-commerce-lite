# Meta Conversions Components

Admin UI for configuring and monitoring Meta (Facebook) Conversions API server-side event tracking.

## Files

| File | Description |
|------|-------------|
| `index.ts` | Barrel export: `MetaConversionsContainer` aliased as `MetaConversionsManager` |
| `MetaConversionsContainer.tsx` | Top-level container with two tabs: Settings and Logs |
| `MetaConversionsSettingsForm.tsx` | Configuration form for Pixel ID, access token (with show/hide toggle), test event code, log retention days, enable/disable switch. Uses `useMetaConversionsSettings` hook. Tracks unsaved changes with reset button |
| `MetaConversionsLogs.tsx` | Paginated log viewer with expandable row details. Refresh, manual cleanup (retention-based), clear all buttons. Status badges (success/failed). Custom pagination with first/last/numbered page buttons |
| `LogDetails.tsx` | Expandable detail view for individual log entries (request/response payloads, error messages) |
| `hooks/useMetaConversionsSettings.ts` | Hook managing settings form state, load/save API calls, dirty tracking, form reset |
| `hooks/useMetaConversionsLogs.ts` | Hook managing log list state, pagination, clear/cleanup dialogs, page changes |

## Types

### `MetaConversionsSettings` (local type, not imported from DB schema)
```typescript
{
  id: string;
  singletonKey: string;
  pixelId: string | null;
  accessToken: string | null;
  testEventCode: string | null;
  isEnabled: boolean;
  logRetentionDays: number;
  createdAt: Date;
  updatedAt: Date;
}
```

### `RetentionInfo`
```typescript
{ hours: number; cleanupIntervalHours: number; nextCleanupMessage: string }
```

## API Endpoints Used

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/settings/meta-conversions` | Get settings (access token is masked) |
| POST | `/admin/settings/meta-conversions` | Save settings |
| GET | `/admin/settings/meta-conversions/logs?page=N&limit=N` | Get paginated logs with retention info |
| DELETE | `/admin/settings/meta-conversions/logs` | Clear all logs |
| POST | `/admin/settings/meta-conversions/logs` | Manual log cleanup (retention-based) |

## Dependencies

- shadcn/ui components (Card, Tabs, Input, Label, Switch, Button, Badge, Table, AlertDialog)
- `lucide-react` for icons (Settings, Activity, Save, RotateCcw, Eye, EyeOff, etc.)
- `sonner` for toast notifications (via hooks)
