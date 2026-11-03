-- The SQLite-profile JSON functions take every JSON shape as SQLite does
-- (the same text as the bootstrap's POSTGRES_JSON_SHAPE_FUNCTIONS_SQL).
CREATE OR REPLACE FUNCTION public.json_array_length(input_text text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT CASE WHEN jsonb_typeof(target.value) = 'array' THEN jsonb_array_length(target.value) ELSE 0 END::bigint
  FROM (SELECT input_text::jsonb AS value) AS target
$function$;

CREATE OR REPLACE FUNCTION public.json_array_length(input_text text, json_path text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT CASE
    WHEN target.value IS NULL THEN NULL
    WHEN jsonb_typeof(target.value) = 'array' THEN jsonb_array_length(target.value)
    ELSE 0
  END::bigint
  FROM (SELECT scalius_compat.json_path_value(input_text, json_path) AS value) AS target
$function$;

CREATE OR REPLACE FUNCTION public.json_array_length(input_json jsonb, json_path text DEFAULT '$')
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT CASE
    WHEN target.value IS NULL THEN NULL
    WHEN jsonb_typeof(target.value) = 'array' THEN jsonb_array_length(target.value)
    ELSE 0
  END::bigint
  FROM (SELECT scalius_compat.json_path_value(input_json, json_path) AS value) AS target
$function$;

CREATE OR REPLACE FUNCTION public.json_each(input_text text, json_path text DEFAULT '$')
RETURNS TABLE(
  key text,
  value text,
  type text,
  atom text,
  id bigint,
  parent bigint,
  fullkey text,
  path text
)
LANGUAGE plpgsql
IMMUTABLE
STRICT
ROWS 10
AS $function$
DECLARE
  target jsonb;
BEGIN
  target := scalius_compat.json_path_value(input_text, json_path);
  IF target IS NULL THEN
    RETURN;
  ELSIF jsonb_typeof(target) = 'array' THEN
    RETURN QUERY
      SELECT
        (entry.ordinality - 1)::text,
        scalius_compat.json_scalar_text(entry.element),
        public.json_type(entry.element::text),
        CASE WHEN jsonb_typeof(entry.element) IN ('array', 'object') THEN NULL
             ELSE scalius_compat.json_scalar_text(entry.element) END,
        entry.ordinality::bigint,
        NULL::bigint,
        json_path || '[' || (entry.ordinality - 1)::text || ']',
        json_path
      FROM jsonb_array_elements(target) WITH ORDINALITY AS entry(element, ordinality);
  ELSIF jsonb_typeof(target) = 'object' THEN
    RETURN QUERY
      SELECT
        entry.object_key,
        scalius_compat.json_scalar_text(entry.element),
        public.json_type(entry.element::text),
        CASE WHEN jsonb_typeof(entry.element) IN ('array', 'object') THEN NULL
             ELSE scalius_compat.json_scalar_text(entry.element) END,
        row_number() OVER (ORDER BY entry.object_key)::bigint,
        NULL::bigint,
        json_path || '.' || entry.object_key,
        json_path
      FROM jsonb_each(target) AS entry(object_key, element);
  ELSE
    RETURN QUERY
      SELECT
        NULL::text,
        scalius_compat.json_scalar_text(target),
        public.json_type(target::text),
        scalius_compat.json_scalar_text(target),
        0::bigint,
        NULL::bigint,
        json_path,
        json_path;
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION scalius_compat.json_each_jsonb(
  input_json jsonb,
  json_path text DEFAULT '$'
)
RETURNS TABLE(
  key text,
  value jsonb,
  type text,
  atom text,
  id bigint,
  parent bigint,
  fullkey text,
  path text
)
LANGUAGE plpgsql
IMMUTABLE
STRICT
ROWS 10
AS $function$
DECLARE
  target jsonb;
BEGIN
  target := scalius_compat.json_path_value(input_json, json_path);
  IF target IS NULL THEN
    RETURN;
  ELSIF jsonb_typeof(target) = 'array' THEN
    RETURN QUERY
      SELECT
        (entry.ordinality - 1)::text,
        entry.element,
        public.json_type(entry.element::text),
        CASE WHEN jsonb_typeof(entry.element) IN ('array', 'object') THEN NULL
             ELSE scalius_compat.json_scalar_text(entry.element) END,
        entry.ordinality::bigint,
        NULL::bigint,
        json_path || '[' || (entry.ordinality - 1)::text || ']',
        json_path
      FROM jsonb_array_elements(target) WITH ORDINALITY AS entry(element, ordinality);
  ELSIF jsonb_typeof(target) = 'object' THEN
    RETURN QUERY
      SELECT
        entry.object_key,
        entry.element,
        public.json_type(entry.element::text),
        CASE WHEN jsonb_typeof(entry.element) IN ('array', 'object') THEN NULL
             ELSE scalius_compat.json_scalar_text(entry.element) END,
        row_number() OVER (ORDER BY entry.object_key)::bigint,
        NULL::bigint,
        json_path || '.' || entry.object_key,
        json_path
      FROM jsonb_each(target) AS entry(object_key, element);
  ELSE
    RETURN QUERY
      SELECT
        NULL::text,
        target,
        public.json_type(target::text),
        scalius_compat.json_scalar_text(target),
        0::bigint,
        NULL::bigint,
        json_path,
        json_path;
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION scalius_compat.json_each_jsonb(
  input_text text,
  json_path text DEFAULT '$'
)
RETURNS TABLE(
  key text,
  value jsonb,
  type text,
  atom text,
  id bigint,
  parent bigint,
  fullkey text,
  path text
)
LANGUAGE sql
IMMUTABLE
STRICT
ROWS 10
AS $function$
  SELECT * FROM scalius_compat.json_each_jsonb(input_text::jsonb, json_path)
$function$;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (190, '0190_postgres_json_shapes', '693bf2d05d935e9d49867a27adbc191c73e41419bb957f813ad8c1ce6c002a6e');
