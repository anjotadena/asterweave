// A tiny structural checker (a deliberate subset of JSON Schema) for the runtime's own data: graph
// definitions, run state, actions. Zero dependencies, never throws on bad input, and never echoes a
// checked VALUE into a message (only the path and the spec's own words), so an error is safe to log.
//
// Supported spec keywords: type (name or array of names: string number integer boolean null array
// object), enum, const, required, properties, additionalProperties (false | spec), pattern, minLength,
// maxLength, items, minItems, maxItems, uniqueItems, min, max.
//
//   check(value, spec, path = "$") -> string[]     (empty array = valid)
import { stringifyJson } from "../json.mjs";

const MAX_DEPTH = 64;
const MAX_ERRORS = 100;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const TYPE_CHECKS = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  null: (value) => value === null,
  array: (value) => Array.isArray(value),
  object: isObject,
};

const PATTERNS = new Map();
function patternFor(source) {
  let regex = PATTERNS.get(source);
  if (!regex) {
    regex = new RegExp(source);
    PATTERNS.set(source, regex);
  }
  return regex;
}

const same = (left, right) => left === right || (typeof left === "object" && typeof right === "object" && stringifyJson(left) === stringifyJson(right));

const childPath = (path, key) => (/^[A-Za-z_][\w-]*$/.test(key) ? `${path}.${key}` : `${path}[${stringifyJson(key)}]`);

function walk(value, spec, path, errors, depth) {
  if (errors.length >= MAX_ERRORS) return;
  const push = (message) => {
    if (errors.length < MAX_ERRORS) errors.push(`${path}: ${message}`);
  };
  if (depth > MAX_DEPTH) return push("nested too deeply");
  if (!isObject(spec)) return push("invalid spec");

  if ("const" in spec) {
    if (!same(value, spec.const)) push(`must equal ${stringifyJson(spec.const)}`);
    return;
  }
  if (spec.type !== undefined) {
    const types = [].concat(spec.type);
    for (const type of types) if (!Object.hasOwn(TYPE_CHECKS, type)) return push(`invalid spec type ${stringifyJson(type)}`);
    if (!types.some((type) => TYPE_CHECKS[type](value))) return push(`expected ${types.join(" or ")}`);
  }
  if (Array.isArray(spec.enum) && !spec.enum.some((candidate) => same(candidate, value))) {
    push(`must be one of ${spec.enum.map((candidate) => stringifyJson(candidate)).join(", ")}`);
  }

  if (typeof value === "string") {
    if (typeof spec.pattern === "string" && !patternFor(spec.pattern).test(value)) push(`does not match ${spec.pattern}`);
    if (Number.isInteger(spec.minLength) && value.length < spec.minLength) push(`shorter than ${spec.minLength}`);
    if (Number.isInteger(spec.maxLength) && value.length > spec.maxLength) push(`longer than ${spec.maxLength}`);
  }

  if (typeof value === "number") {
    if (typeof spec.min === "number" && value < spec.min) push(`below ${spec.min}`);
    if (typeof spec.max === "number" && value > spec.max) push(`above ${spec.max}`);
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(spec.minItems) && value.length < spec.minItems) push(`fewer than ${spec.minItems} items`);
    if (Number.isInteger(spec.maxItems) && value.length > spec.maxItems) push(`more than ${spec.maxItems} items`);
    if (spec.uniqueItems === true && new Set(value.map((item) => stringifyJson(item))).size !== value.length) push("items must be unique");
    if (spec.items !== undefined) {
      for (let index = 0; index < value.length && errors.length < MAX_ERRORS; index += 1) {
        walk(value[index], spec.items, `${path}[${index}]`, errors, depth + 1);
      }
    }
  }

  if (isObject(value)) {
    const keys = Object.keys(value);
    for (const key of Array.isArray(spec.required) ? spec.required : []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) push(`missing required property ${key}`);
    }
    const properties = isObject(spec.properties) ? spec.properties : {};
    for (const key of keys) {
      if (value[key] === undefined) continue;
      if (Object.hasOwn(properties, key)) walk(value[key], properties[key], childPath(path, key), errors, depth + 1);
      else if (spec.additionalProperties === false) {
        if (errors.length < MAX_ERRORS) errors.push(`${childPath(path, key)}: unexpected property`);
      } else if (isObject(spec.additionalProperties)) {
        walk(value[key], spec.additionalProperties, childPath(path, key), errors, depth + 1);
      }
    }
  }
}

/**
 * @param {unknown} value
 * @param {object} spec
 * @param {string} [path]
 * @returns {string[]} human-readable problems; empty when `value` satisfies `spec`
 */
export function check(value, spec, path = "$") {
  const errors = [];
  walk(value, spec, path, errors, 0);
  return errors;
}
