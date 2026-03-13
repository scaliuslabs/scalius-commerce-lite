#!/usr/bin/env node
/**
 * Patches @asteasolutions/zod-to-openapi@7 for Zod v4 compatibility.
 *
 * Zod v4 breaking changes that affect zod-to-openapi:
 * 1. _def.typeName -> _def.type (e.g. "ZodOptional" -> "optional")
 * 2. _def.shape() -> _def.shape (function -> plain object)
 * 3. _def.checks -> direct properties (e.g. _def.minLength, _def.maxLength)
 * 4. _def.defaultValue() -> _def.defaultValue (function -> plain value)
 *
 * Run via: node scripts/patch-zod-openapi.cjs
 * Or add to package.json postinstall.
 */

const fs = require("fs");
const path = require("path");

const PATCH_MARKER = "/* zod-v4-compat-patched */";

const pnpmDir = path.resolve(__dirname, "../../../node_modules/.pnpm");
const candidates = [];

if (fs.existsSync(pnpmDir)) {
  for (const entry of fs.readdirSync(pnpmDir)) {
    if (entry.startsWith("@asteasolutions+zod-to-openapi@7") && entry.includes("zod@4")) {
      candidates.push(
        path.join(pnpmDir, entry, "node_modules/@asteasolutions/zod-to-openapi/dist/index.cjs")
      );
    }
  }
}

let patched = 0;
for (const cjsPath of candidates) {
  if (!fs.existsSync(cjsPath)) continue;

  let content = fs.readFileSync(cjsPath, "utf8");

  if (content.includes(PATCH_MARKER)) {
    console.log(`[patch] Already patched`);
    continue;
  }

  // 1. Patch isZodType
  const oldIsZodType = `function isZodType(schema, typeName) {\n    var _a;\n    return ((_a = schema === null || schema === void 0 ? void 0 : schema._def) === null || _a === void 0 ? void 0 : _a.typeName) === typeName;\n}`;
  const newIsZodType = `${PATCH_MARKER} function isZodType(schema, typeName) {
    var _a, _b;
    if (((_a = schema === null || schema === void 0 ? void 0 : schema._def) === null || _a === void 0 ? void 0 : _a.typeName) === typeName) return true;
    var _m = {ZodString:"string",ZodNumber:"number",ZodBoolean:"boolean",ZodObject:"object",ZodArray:"array",ZodOptional:"optional",ZodNullable:"nullable",ZodDefault:"default",ZodEnum:"enum",ZodNativeEnum:"nativeEnum",ZodLiteral:"literal",ZodUnion:"union",ZodDiscriminatedUnion:"discriminatedUnion",ZodIntersection:"intersection",ZodRecord:"record",ZodTuple:"tuple",ZodSet:"set",ZodMap:"map",ZodEffects:"effects",ZodPipeline:"pipe",ZodBranded:"branded",ZodReadonly:"readonly",ZodLazy:"lazy",ZodVoid:"void",ZodNever:"never",ZodUnknown:"unknown",ZodAny:"any",ZodNull:"null",ZodUndefined:"undefined",ZodNaN:"nan",ZodDate:"date",ZodBigInt:"bigint",ZodSymbol:"symbol",ZodPromise:"promise"};
    return ((_b = schema === null || schema === void 0 ? void 0 : schema._def) === null || _b === void 0 ? void 0 : _b.type) === _m[typeName];
}`;
  content = content.replace(oldIsZodType, newIsZodType);

  // 2. Patch _def.shape() -> handle plain object
  content = content.replace(
    /(\w+)\._def\.shape\(\)/g,
    '(typeof $1._def.shape === "function" ? $1._def.shape() : $1._def.shape)'
  );
  content = content.replace(
    /parent\s*===\s*null\s*\|\|\s*parent\s*===\s*void 0\s*\?\s*void 0\s*:\s*\(typeof parent\._def\.shape === "function" \? parent\._def\.shape\(\) : parent\._def\.shape\)/g,
    '(parent === null || parent === void 0 ? {} : (typeof parent._def.shape === "function" ? parent._def.shape() : parent._def.shape || {}))'
  );

  // 3. Patch getZodStringCheck
  const oldStrCheck = `getZodStringCheck(zodString, kind) {
        return zodString._def.checks.find((check) => {
            return check.kind === kind;
        });
    }`;
  const newStrCheck = `getZodStringCheck(zodString, kind) {
        if (zodString._def.checks) return zodString._def.checks.find(function(c){return c.kind===kind;});
        if (kind==='min'&&zodString._def.minLength!=null) return {kind:'min',value:zodString._def.minLength};
        if (kind==='max'&&zodString._def.maxLength!=null) return {kind:'max',value:zodString._def.maxLength};
        if (kind==='email'&&zodString._def.format==='email') return {kind:'email'};
        if (kind==='url'&&zodString._def.format==='url') return {kind:'url'};
        if (kind==='uuid'&&zodString._def.format==='uuid') return {kind:'uuid'};
        if (kind==='regex'&&zodString._def.pattern) return {kind:'regex',regex:zodString._def.pattern};
        return undefined;
    }`;
  content = content.replace(oldStrCheck, newStrCheck);

  // 4. Patch number checks
  content = content.replace(
    "getNumberChecks(zodSchema._def.checks)",
    "getNumberChecks(zodSchema._def.checks || [])"
  );

  // 5. Patch defaultValue
  content = content.replace(
    "return unwrapped === null || unwrapped === void 0 ? void 0 : unwrapped._def.defaultValue();",
    'var _dv = unwrapped === null || unwrapped === void 0 ? void 0 : unwrapped._def.defaultValue; return typeof _dv === "function" ? _dv() : _dv;'
  );

  // 6. Patch enum values (v4 may use entries instead of values)
  content = content.replace(
    /zodSchema\._def\.values(?![\.\w])/g,
    '(zodSchema._def.values || (zodSchema._def.entries ? Object.keys(zodSchema._def.entries) : []))'
  );

  fs.writeFileSync(cjsPath, content);
  patched++;
  console.log(`[patch] Patched: ${path.basename(cjsPath)}`);
}

console.log(patched === 0 ? "[patch] No unpatched files found" : `[patch] Done: ${patched} file(s)`);
