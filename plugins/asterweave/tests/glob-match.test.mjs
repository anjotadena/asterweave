import test from "node:test";
import assert from "node:assert/strict";

import { findOverlap, matchesAny, matchesGlob, prefixesOverlap } from "../scripts/lib/glob-match.mjs";

test("matches a directory glob against nested paths but not siblings", () => {
  assert.equal(matchesGlob("src/Finance/**", "src/Finance/RefundService.cs"), true);
  assert.equal(matchesGlob("src/Finance/**", "src/Finance/Sub/Deep.cs"), true);
  assert.equal(matchesGlob("src/Finance/**", "src/Inventory/StockService.cs"), false);
});

test("matches a single-segment wildcard without crossing directories", () => {
  assert.equal(matchesGlob("src/Finance/*.cs", "src/Finance/Refund.cs"), true);
  assert.equal(matchesGlob("src/Finance/*.cs", "src/Finance/Sub/Refund.cs"), false);
});

test("normalizes backslashes and a leading ./ before matching", () => {
  assert.equal(matchesGlob("src/Finance/**", "./src\\Finance\\Refund.cs"), true);
});

test("matchesAny is true when any pattern in the list matches", () => {
  assert.equal(matchesAny(["src/Inventory/**", "src/HRIS/**"], "src/HRIS/Employee.cs"), true);
  assert.equal(matchesAny(["src/Inventory/**", "src/HRIS/**"], "src/Finance/Refund.cs"), false);
  assert.equal(matchesAny([], "src/Finance/Refund.cs"), false);
});

test("prefixesOverlap flags real ownership collisions and clears unrelated modules", () => {
  assert.equal(prefixesOverlap("src/Finance/**", "src/Finance/Ledger.cs"), true);
  assert.equal(prefixesOverlap("src/Finance/**", "src/Finance/**"), true);
  assert.equal(prefixesOverlap("src/Finance/**", "src/Inventory/**"), false);
});

test("findOverlap returns the first colliding pair or null", () => {
  const overlap = findOverlap(["src/Finance/**", "tests/Finance/**"], ["src/Finance/Ledger.cs"]);
  assert.deepEqual(overlap, { a: "src/Finance/**", b: "src/Finance/Ledger.cs" });
  assert.equal(findOverlap(["src/Finance/**"], ["src/Inventory/**"]), null);
});
