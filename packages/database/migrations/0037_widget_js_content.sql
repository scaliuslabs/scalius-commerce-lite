-- Add scoped widget JavaScript content.
-- JavaScript is stored separately from HTML so storefront rendering can wrap it
-- in the widget runtime root instead of trusting arbitrary script tags in HTML.

ALTER TABLE widgets ADD COLUMN js_content text;
ALTER TABLE widget_history ADD COLUMN js_content text;
