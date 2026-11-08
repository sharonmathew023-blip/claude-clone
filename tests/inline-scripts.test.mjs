import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((match) => match[1]).filter((script) => script.trim());
assert.ok(scripts.length > 0, "expected inline application script");
scripts.forEach((script, index) => new vm.Script(script, { filename: `index-inline-${index}.js` }));
console.log(`inline script syntax: ${scripts.length} script(s) passed`);
