// A member's workspace scope: all, or a named few — as text in an invite
// and as a list on the member.

import test from "node:test";
import assert from "node:assert/strict";
import { formatScope, parseScope, scopeAllows, describeScope } from "../src/scope.ts";

test("all, none and some round-trip through the invite's text", () => {
  assert.equal(formatScope(null), "*");
  assert.equal(parseScope("*"), null);
  assert.deepEqual(parseScope(formatScope(["leads", "seo-desk"])), ["leads", "seo-desk"]);
  assert.deepEqual(parseScope(formatScope([])), []);
});

test("an unreadable scope grants nothing, not everything", () => {
  assert.deepEqual(parseScope("../etc+leads"), ["leads"]);
  assert.deepEqual(parseScope("garbage!"), []);
});

test("allows and describes", () => {
  assert.equal(scopeAllows(null, "anything"), true);
  assert.equal(scopeAllows(["leads"], "leads"), true);
  assert.equal(scopeAllows(["leads"], "seo"), false);
  assert.equal(describeScope(null), "all workspaces");
  assert.equal(describeScope([]), "no workspaces");
  assert.equal(describeScope(["leads"]), "leads");
  assert.equal(describeScope(["leads", "seo"]), "leads and seo");
  assert.equal(describeScope(["a", "b", "c", "d"]), "a and 3 more");
});
