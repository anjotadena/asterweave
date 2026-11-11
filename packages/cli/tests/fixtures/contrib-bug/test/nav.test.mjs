import assert from "node:assert/strict";
import test from "node:test";
import { createNav } from "../src/nav.mjs";

test("opening a project shows the project page", () => {
  const nav = createNav();
  nav.openProject("p1");
  assert.deepEqual(nav.view, { page: "project", id: "p1", search: "" });
});

test("going back with nothing to go back to keeps the current view", () => {
  const nav = createNav();
  nav.goBack();
  assert.deepEqual(nav.view, { page: "list", search: "" });
});
