// Tests for the Telegram reply parser. Run: node --test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseZoneReply, buttonRows } from "./telegram.ts";

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

test("buttonRows: bare callback_data, single row under 4", () => {
  assert.deepEqual(buttonRows(["z1", "z2"]), [
    [
      { text: "z1", callback_data: "z1" },
      { text: "z2", callback_data: "z2" },
    ],
  ]);
});

test("buttonRows: prefix goes into callback_data only, not the label", () => {
  assert.deepEqual(buttonRows(["z1"], "ss:"), [[{ text: "z1", callback_data: "ss:z1" }]]);
});

test("buttonRows: chunks into rows of 4", () => {
  const rows = buttonRows(["z1", "z2", "z3", "z4", "z5"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length, 4);
  assert.deepEqual(rows[1], [{ text: "z5", callback_data: "z5" }]);
});

test("buttonRows: empty codes -> no rows", () => {
  assert.deepEqual(buttonRows([]), []);
});
