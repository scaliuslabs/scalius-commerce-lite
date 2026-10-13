# Customer conversation journeys

Core and plugin themes share these components on the account inbox, owned order,
receipt/track-order and warranty claim pages. A warranty *creation* form also
uses the composer, but has no thread read route and must never start polling.

- Rendering a page or polling never marks messages read. JavaScript acknowledges
  only visible rows while the tab is visible; no-JavaScript users have an explicit
  **Mark messages as read** form. The proxy authorizes every account/receipt read
  independently and never forwards proof in URLs or response bodies.
- The controller reads immutable public rows after its highest displayed sequence.
  Private-note gaps are valid. Older history prepends without replacing current
  rows or drafts; guests use the same authorized history projection. Plain links
  retain history navigation without JavaScript.
- Polling is one request at a time: 4 seconds for two minutes after a new message
  or send, then 10 seconds while active, 60 seconds when idle or offscreen. Hidden
  and offline tabs stop; 30 minutes without interaction stops until activity.
  Throttling honors Retry-After, failures back off, and catch-up stops after four
  pages with an honest reload action. No customer joins the staff realtime hub.
- Sends and polls merge immutable rows. A send response must overlap the current
  cursor or contain the full history before it can advance it; otherwise the
  incremental read fills the gap. A response never clears text or photos edited
  while sending. Unknown-outcome retries retain the key only for the same draft.
- Shared `conversation-grouping` determines grouping. The initial HTML, post and
  read proxies use one renderer. All layout uses storefront tokens; customer
  layouts must be verified in both core and plugin themes.
- Cart sharing is separate explicit, versioned consent; it does not send a message
  or silently follow cart edits. Its controller and component own that lifecycle.

Browser acceptance: two-sided replies without refresh; reading history while new
messages arrive; draft edits during a slow send; hidden/offline/resume; guest
history and no-JS acknowledgment; phone long text/images; core and Noor. Unit
passes alone do not establish these composed journeys.


The account thread route opts into `AccountShell`'s workspace layout and the
composer's dock variant. Its history pane owns scrolling/read visibility; the
tray stays reachable and shares theme tokens across all built-in templates and
plugins. Shell height measures the real theme chrome and consumes the existing
mobile-tab reservation, including its safe area. A 32rem minimum keeps tall
headers from crushing the history pane; status shares the heading row. Without JavaScript or
below 34rem viewport height, it returns to ordinary document flow. Order and
warranty embeds keep their stack composer and window scroll behavior. Test
actual keyboard, attachment, cart disclosure, first-unread and prepend journeys
when changing either the shell or pane geometry.
