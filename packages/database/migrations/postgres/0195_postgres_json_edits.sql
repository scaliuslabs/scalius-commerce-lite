-- The SQLite-profile JSON editors (json_set, json_insert, json_replace,
-- json_remove) with SQLite's answer for every path a document has or lacks
-- (the same text as the bootstrap's POSTGRES_JSON_EDIT_FUNCTIONS_SQL).
CREATE OR REPLACE FUNCTION scalius_compat.json_path_steps(json_path text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  steps text[] := ARRAY[]::text[];
  rest text;
  step text[];
BEGIN
  IF left(json_path, 1) <> '$' THEN
    RAISE EXCEPTION 'bad JSON path: %', quote_literal(json_path) USING ERRCODE = '22023';
  END IF;
  rest := substr(json_path, 2);
  WHILE rest <> '' LOOP
    step := regexp_match(rest, '^(\."([^"\\]*)"(?=$|[.[])|\.([^.["][^.[]*)|\[([0-9]+|#(?:-[0-9]+)?)\])');
    IF step IS NULL THEN
      RAISE EXCEPTION 'bad JSON path: %', quote_literal(json_path) USING ERRCODE = '22023';
    END IF;
    steps := steps || CASE WHEN step[4] IS NULL THEN '.' || coalesce(step[2], step[3]) ELSE '[' || step[4] END;
    rest := substr(rest, length(step[1]) + 1);
  END LOOP;
  RETURN steps;
END
$function$;

CREATE OR REPLACE FUNCTION scalius_compat.json_edit(target jsonb, steps text[], new_value jsonb, mode text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  step text := steps[1];
  rest text[] := steps[2:];
  location text[];
  child jsonb;
  empty jsonb;
  size bigint;
  position numeric;
BEGIN
  IF step IS NULL THEN
    RETURN CASE mode WHEN 'insert' THEN target WHEN 'remove' THEN NULL ELSE new_value END;
  END IF;
  IF left(step, 1) = '.' THEN
    IF jsonb_typeof(target) IS DISTINCT FROM 'object' THEN RETURN target; END IF;
    location := ARRAY[substr(step, 2)];
    child := target -> location[1];
  ELSE
    IF jsonb_typeof(target) IS DISTINCT FROM 'array' THEN RETURN target; END IF;
    size := jsonb_array_length(target);
    position := CASE WHEN substr(step, 2, 1) = '#'
      THEN size - coalesce(nullif(substr(step, 4), '')::numeric, 0)
      ELSE substr(step, 2)::numeric END;
    IF position < 0 OR position > size THEN RETURN target; END IF;
    location := ARRAY[position::text];
    child := target -> position::integer;
  END IF;
  IF child IS NOT NULL THEN
    IF mode = 'remove' AND rest = ARRAY[]::text[] THEN RETURN target #- location; END IF;
    RETURN jsonb_set(target, location, scalius_compat.json_edit(child, rest, new_value, mode));
  END IF;
  IF mode NOT IN ('set', 'insert') THEN RETURN target; END IF;
  IF rest = ARRAY[]::text[] THEN
    child := new_value;
  ELSE
    empty := CASE WHEN left(rest[1], 1) = '.' THEN '{}'::jsonb ELSE '[]'::jsonb END;
    child := scalius_compat.json_edit(empty, rest, new_value, mode);
    IF child = empty THEN RETURN target; END IF;
  END IF;
  RETURN CASE WHEN jsonb_typeof(target) = 'array'
    THEN target || jsonb_build_array(child)
    ELSE target || jsonb_build_object(location[1], child) END;
END
$function$;

CREATE OR REPLACE FUNCTION scalius_compat.json_edit_text(input_text text, json_path text, new_value jsonb, mode text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN input_text IS NULL THEN NULL
    WHEN json_path IS NULL THEN input_text::jsonb::text
    ELSE scalius_compat.json_edit(
      input_text::jsonb,
      scalius_compat.json_path_steps(json_path),
      coalesce(new_value, 'null'::jsonb),
      mode
    )::text
  END
$function$;

CREATE OR REPLACE FUNCTION scalius_compat.json_value(value anyelement)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN value IS NULL THEN 'null'::jsonb
    WHEN pg_typeof(value) = 'boolean'::regtype THEN to_jsonb(CASE WHEN value::text = 'true' THEN 1 ELSE 0 END)
    ELSE to_jsonb(value)
  END
$function$;

CREATE OR REPLACE FUNCTION public.json_set(input_text text, json_path text, value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT scalius_compat.json_edit_text(input_text, json_path, to_jsonb(value), 'set')
$function$;

CREATE OR REPLACE FUNCTION public.json_set(input_text text, json_path text, value anyelement)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT scalius_compat.json_edit_text(input_text, json_path, scalius_compat.json_value(value), 'set')
$function$;

CREATE OR REPLACE FUNCTION public.json_insert(input_text text, json_path text, value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT scalius_compat.json_edit_text(input_text, json_path, to_jsonb(value), 'insert')
$function$;

CREATE OR REPLACE FUNCTION public.json_insert(input_text text, json_path text, value anyelement)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT scalius_compat.json_edit_text(input_text, json_path, scalius_compat.json_value(value), 'insert')
$function$;

CREATE OR REPLACE FUNCTION public.json_replace(input_text text, json_path text, value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT scalius_compat.json_edit_text(input_text, json_path, to_jsonb(value), 'replace')
$function$;

CREATE OR REPLACE FUNCTION public.json_replace(input_text text, json_path text, value anyelement)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT scalius_compat.json_edit_text(input_text, json_path, scalius_compat.json_value(value), 'replace')
$function$;

CREATE OR REPLACE FUNCTION public.json_remove(input_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT input_text::jsonb::text
$function$;

CREATE OR REPLACE FUNCTION public.json_remove(input_text text, VARIADIC json_paths text[])
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  result jsonb;
  json_path text;
BEGIN
  IF input_text IS NULL OR json_paths IS NULL OR array_position(json_paths, NULL) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  result := input_text::jsonb;
  FOREACH json_path IN ARRAY json_paths LOOP
    result := scalius_compat.json_edit(result, scalius_compat.json_path_steps(json_path), NULL, 'remove');
    IF result IS NULL THEN RETURN NULL; END IF;
  END LOOP;
  RETURN result::text;
END
$function$;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (195, '0195_postgres_json_edits', '8ab5a63ebdd53b349e4b5f53f80083c045623f5b0573a5972bcd3947b771666e');
