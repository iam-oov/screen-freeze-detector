// Coordinate mapping for the zone selector (step 6). Run: node --test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { cssRectToBbox, bboxCenterToScreen } from "./capture.ts";

// Frame is 1000x800 physical px shown at 500x400 CSS px -> 2x downscale.
test("css rect maps to physical pixels via the display scale", () => {
  const bbox = cssRectToBbox({ left: 100, top: 80, width: 50, height: 40 }, 1000, 800, 500, 400);
  assert.deepEqual(bbox, [200, 160, 300, 240]);
});

test("1:1 display is identity", () => {
  const bbox = cssRectToBbox({ left: 10, top: 20, width: 30, height: 40 }, 800, 600, 800, 600);
  assert.deepEqual(bbox, [10, 20, 40, 60]);
});

test("out-of-frame selection clamps to bounds", () => {
  const bbox = cssRectToBbox({ left: 480, top: 380, width: 100, height: 100 }, 1000, 800, 500, 400);
  // right/bottom would map past 1000/800; clamped.
  assert.deepEqual(bbox, [960, 760, 1000, 800]);
});

// Capture is 2x the logical screen (Retina): physical center halves to logical.
test("bbox center maps from capture pixels to logical screen points", () => {
  const p = bboxCenterToScreen([200, 160, 400, 360], 2000, 1600, 1000, 800);
  assert.deepEqual(p, { x: 150, y: 130 }); // center (300,260) * 0.5
});

test("1:1 capture/screen is identity center", () => {
  const p = bboxCenterToScreen([100, 100, 300, 300], 1000, 800, 1000, 800);
  assert.deepEqual(p, { x: 200, y: 200 });
});
