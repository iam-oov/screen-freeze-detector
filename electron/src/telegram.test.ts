// Tests for the Telegram reply parser. Run: node --test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseZoneReply, buttonRows, parseCtrlc, parseUp, parseDown, parseEnter } from "./telegram.ts";

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

test("parseCtrlc: space form returns the zone code", () => {
  assert.equal(parseCtrlc("z2 ctrlc"), "z2");
});

test("parseCtrlc: colon form returns the zone code", () => {
  assert.equal(parseCtrlc("z2: ctrlc"), "z2");
});

test("parseCtrlc: case-insensitive", () => {
  assert.equal(parseCtrlc("Z2 CTRLC"), "Z2");
});

test("parseCtrlc: bare ctrlc -> null (requires an explicit zone)", () => {
  assert.equal(parseCtrlc("ctrlc"), null);
});

test("parseCtrlc: trailing ctrlc inside a longer message -> null", () => {
  assert.equal(parseCtrlc("z2: type ctrlc please"), null);
});

test("parseUp: zone + count (space form)", () => {
  assert.deepEqual(parseUp("z2 up 4"), { zone: "z2", count: 4 });
});

test("parseUp: zone + count (colon form)", () => {
  assert.deepEqual(parseUp("z2: up 3"), { zone: "z2", count: 3 });
});

test("parseUp: no count defaults to 1", () => {
  assert.deepEqual(parseUp("z2 up"), { zone: "z2", count: 1 });
});

test("parseUp: bare up (no zone) -> null", () => {
  assert.equal(parseUp("up 4"), null);
});

test("parseUp: extra words -> null", () => {
  assert.equal(parseUp("z2 up now"), null);
});

test("parseDown: zone + count (space form)", () => {
  assert.deepEqual(parseDown("z2 down 3"), { zone: "z2", count: 3 });
});

test("parseDown: colon form, no count defaults to 1", () => {
  assert.deepEqual(parseDown("z2: down"), { zone: "z2", count: 1 });
});

test("parseDown: bare down (no zone) -> null", () => {
  assert.equal(parseDown("down 2"), null);
});

test("parseDown: 'up' is not matched by parseDown", () => {
  assert.equal(parseDown("z2 up"), null);
});

test("parseEnter: zone (space form)", () => {
  assert.equal(parseEnter("z2 enter"), "z2");
});

test("parseEnter: zone (colon form)", () => {
  assert.equal(parseEnter("z2: enter"), "z2");
});

test("parseEnter: bare enter -> null (stays the selected-zone reply word)", () => {
  assert.equal(parseEnter("enter"), null);
});

test("parseEnter: extra words -> null", () => {
  assert.equal(parseEnter("z2 enter now"), null);
});
