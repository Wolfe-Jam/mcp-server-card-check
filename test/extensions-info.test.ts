/**
 * Remote.extensionsInfo (ext-server-card #55, merged 2026-11-19): every entry
 * must be an object. The two cards are #55's own examples at 28db12c9, so the
 * library validator and the precompiled one (CLI + web) both follow upstream.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateCard } from "../src/browser.js";
import { cardValidator } from "../src/validate.js";

const dir = join(import.meta.dirname, "fixtures", "ext-server-card-55");
const load = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const lib = cardValidator();

test("a card with object extensionsInfo entries is valid (#55 valid example)", () => {
  const card = load("remote-extensions-info.json");
  assert.equal(lib(card), null);
  assert.equal(validateCard(card), null);
});

test("a non-object extensionsInfo entry fails validation (#55 invalid example)", () => {
  const card = load("non-object-extension-info.json");
  assert.notEqual(lib(card), null);
  assert.notEqual(validateCard(card), null);
});
