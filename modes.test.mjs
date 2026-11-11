// Run with:  node --test modes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { MODES, applyMode } from "./modes.js";

const base = () => ({ messages: [{ role: "user", content: "hi" }] });

test("chat and missing mode change nothing", () => {
  for (const mode of [undefined, "chat", ""]) {
    const input = { ...base(), mode };
    assert.equal(applyMode(input), null);
    assert.equal(input.messages.length, 1);
    assert.equal(input.web_search, undefined);
  }
});

test("unknown and inherited names are ignored", () => {
  for (const mode of ["admin", "__proto__", "constructor", "toString", 7, null, {}]) {
    const input = { ...base(), mode };
    assert.equal(applyMode(input), null);
    assert.equal(input.messages.length, 1);
  }
});

test("research adds its prompt first and turns on Google Search", () => {
  const input = { ...base(), mode: "research" };
  assert.equal(applyMode(input), "research");
  assert.equal(input.messages[0].role, "system");
  assert.equal(input.messages[0].content, MODES.research.system);
  assert.equal(input.messages[1].content, "hi");
  assert.equal(input.web_search, true);
});

test("agent, studio and developer add a prompt but never turn on search", () => {
  for (const mode of ["agent", "studio", "developer"]) {
    const input = { ...base(), mode };
    assert.equal(applyMode(input), mode);
    assert.equal(input.messages[0].role, "system");
    assert.equal(input.web_search, undefined);
  }
});
