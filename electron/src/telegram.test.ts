// Tests for the Telegram reply parser. Run: node --test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseZoneReply } from "./telegram.ts";

const CODES = ["z1", "z2", "z3"];

test("exact code prefix routes to that zone", () => {
  assert.deepEqual(parseZoneReply("z2: hello", CODES), { zone: "z2", message: "hello" });
});

test("code match is case-insensitive", () => {
  assert.deepEqual(parseZoneReply("Z2: hi", CODES), { zone: "z2", message: "hi" });
});

test("colon with no space still splits", () => {
  assert.deepEqual(parseZoneReply("z1:go", CODES), { zone: "z1", message: "go" });
});

test("empty message after the code", () => {
  assert.deepEqual(parseZoneReply("z3:", CODES), { zone: "z3", message: "" });
});

test("non-code prefix with a colon is left intact", () => {
  assert.deepEqual(parseZoneReply("hello: world", CODES), { zone: null, message: "hello: world" });
});

test("plain text with no colon is untouched", () => {
  assert.deepEqual(parseZoneReply("just type this", CODES), { zone: null, message: "just type this" });
});
