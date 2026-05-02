// Copyright 2023, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Config, DOMPurify } from "dompurify";
import Mustache from "mustache";

export const MAX_MUSTACHE_STATE_JSON_BYTES = 4 * 1024;
export const MAX_MUSTACHE_TEMPLATE_BYTES = 128 * 1024;
export const MAX_MUSTACHE_RENDERED_BYTES = 1024 * 1024;

const MAX_MUSTACHE_DATA_DEPTH = 16;
const MAX_MUSTACHE_DATA_VALUES = 512;
const MAX_MUSTACHE_COLLECTION_ITEMS = 128;
const UNSAFE_MUSTACHE_KEYS = new Set(["__proto__", "constructor", "hasOwnProperty", "prototype"]);

const MUSTACHE_SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    "a",
    "abbr",
    "b",
    "blockquote",
    "br",
    "caption",
    "code",
    "dd",
    "del",
    "div",
    "dl",
    "dt",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "ins",
    "kbd",
    "li",
    "mark",
    "ol",
    "p",
    "pre",
    "s",
    "samp",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
    "var",
  ],
  ALLOWED_ATTR: ["abbr", "colspan", "rowspan", "scope", "title"],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: true,
  RETURN_TRUSTED_TYPE: false,
  SANITIZE_DOM: true,
  SANITIZE_NAMED_PROPS: true,
};

export type BlockTermMustacheVariables = Record<string, unknown>;

export type BlockTermMustacheVariablesResult =
  | { ok: true; variables: BlockTermMustacheVariables }
  | { ok: false; error: string };

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateMustacheValue(value: unknown, depth: number, counter: { value: number }): string | null {
  counter.value += 1;
  if (counter.value > MAX_MUSTACHE_DATA_VALUES) return "state_json contains too many values";
  if (depth > MAX_MUSTACHE_DATA_DEPTH) return "state_json nesting is too deep";
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : "state_json contains an invalid number";
  if (Array.isArray(value)) {
    if (value.length > MAX_MUSTACHE_COLLECTION_ITEMS) return "state_json contains an oversized array";
    for (const item of value) {
      const error = validateMustacheValue(item, depth + 1, counter);
      if (error) return error;
    }
    return null;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    return "state_json contains an unsupported value";
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_MUSTACHE_COLLECTION_ITEMS) return "state_json contains an oversized object";
  for (const [key, item] of entries) {
    if (UNSAFE_MUSTACHE_KEYS.has(key)) return `state_json contains unsupported key ${JSON.stringify(key)}`;
    const error = validateMustacheValue(item, depth + 1, counter);
    if (error) return error;
  }
  return null;
}

export function validateBlockTermMustacheVariables(value: unknown): string | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return "state_json must be a valid JSON object";
  }
  return validateMustacheValue(value, 0, { value: 0 });
}

export function parseBlockTermMustacheVariables(source: string): BlockTermMustacheVariablesResult {
  if (utf8Size(source) > MAX_MUSTACHE_STATE_JSON_BYTES) {
    return { ok: false, error: `state_json too large (max ${MAX_MUSTACHE_STATE_JSON_BYTES} bytes)` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false, error: "state_json must be a valid JSON object" };
  }
  const error = validateBlockTermMustacheVariables(parsed);
  if (error) return { ok: false, error };
  return { ok: true, variables: parsed as BlockTermMustacheVariables };
}

export function blockTermMustacheStateFitsLimit(stateJson: string): boolean {
  return utf8Size(stateJson) <= MAX_MUSTACHE_STATE_JSON_BYTES;
}

export function renderBlockTermMustache(
  template: string,
  variables: BlockTermMustacheVariables,
  purifier: Pick<DOMPurify, "sanitize">
): string {
  if (!template.trim()) throw new Error("mustache template is blank");
  if (utf8Size(template) > MAX_MUSTACHE_TEMPLATE_BYTES) {
    throw new Error(`mustache template is too large (max ${MAX_MUSTACHE_TEMPLATE_BYTES} bytes)`);
  }
  const variablesError = validateBlockTermMustacheVariables(variables);
  if (variablesError) throw new Error(variablesError);
  const rendered = Mustache.render(template, variables);
  if (utf8Size(rendered) > MAX_MUSTACHE_RENDERED_BYTES) {
    throw new Error(`mustache output is too large (max ${MAX_MUSTACHE_RENDERED_BYTES} bytes)`);
  }
  return String(purifier.sanitize(rendered, MUSTACHE_SANITIZE_CONFIG));
}
