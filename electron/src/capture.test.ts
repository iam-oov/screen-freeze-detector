// Coordinate mapping for the zone selector (multi-monitor). Run: node --test.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cssRectToBbox,
  planDraws,
  drawnArea,
  unionBounds,
  bboxCenter,
  isDisplayCovered,
  looksLikeWholeDesktop,
  twoDisplayDirection,
  type DisplayInfo,
  type ScreenGeometry,
} from "./capture.ts";

function display(x: number, y: number, width: number, height: number): DisplayInfo {
  return { id: x + y, label: "", primary: x === 0 && y === 0, x, y, width, height };
}

function geom(x: number, y: number, width: number, height: number, videoWidth = width, videoHeight = height): ScreenGeometry {
  return { display: display(x, y, width, height), videoWidth, videoHeight };
}

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

test("cssRectToBbox with a frame origin shifts the result", () => {
  const bbox = cssRectToBbox({ left: 10, top: 20, width: 30, height: 40 }, 800, 600, 800, 600, -1920, 0);
  assert.deepEqual(bbox, [10 - 1920, 20, 40 - 1920, 60]);
});

// --- planDraws / drawnArea / unionBounds -----------------------------------
// Fixture: A{0,0,1920x1080}, B{1920,0,1920x1080}, both videoW/H == bounds (scale 1).
const A = geom(0, 0, 1920, 1080);
const B = geom(1920, 0, 1920, 1080);

test("planDraws: bbox fully on A -> 1 draw, source rect is bbox-local to A", () => {
  const draws = planDraws([100, 100, 300, 300], [A, B]);
  assert.equal(draws.length, 1);
  assert.equal(draws[0].i, 0);
  assert.equal(draws[0].sx, 100);
  assert.equal(draws[0].dx, 0);
});

test("planDraws: bbox fully on B -> 1 draw against display index 1, sx offset by B.x, dx at the bbox origin", () => {
  const draws = planDraws([2000, 100, 2200, 300], [A, B]);
  assert.equal(draws.length, 1);
  assert.equal(draws[0].i, 1);
  assert.equal(draws[0].sx, 2000 - 1920);
  assert.equal(draws[0].dx, 0);
});

test("planDraws: bbox straddling the seam tiles the output at dx 0 and the seam offset", () => {
  const bbox: [number, number, number, number] = [1800, 100, 2100, 300];
  const draws = planDraws(bbox, [A, B]);
  assert.equal(draws.length, 2);
  const byIndex = [...draws].sort((a, b) => a.i - b.i);
  assert.equal(byIndex[0].dx, 0); // A's slice starts at the bbox's own left edge
  assert.equal(byIndex[0].dw, 1920 - 1800); // 120px of A before the seam
  assert.equal(byIndex[1].dx, 1920 - 1800); // B's slice starts right after A's
  assert.equal(byIndex[1].dw, 2100 - 1920); // 180px of B after the seam
  const w = bbox[2] - bbox[0];
  const h = bbox[3] - bbox[1];
  assert.equal(drawnArea(draws), w * h);
});

test("planDraws: full union -> 2 draws stitched at dx 0 and 1920", () => {
  const draws = planDraws([0, 0, 3840, 1080], [A, B]);
  assert.equal(draws.length, 2);
  const byIndex = [...draws].sort((a, b) => a.i - b.i);
  assert.equal(byIndex[0].dx, 0);
  assert.equal(byIndex[1].dx, 1920);
});

test("planDraws: off-screen bbox has no intersecting display", () => {
  const draws = planDraws([5000, 5000, 5100, 5100], [A, B]);
  assert.deepEqual(draws, []);
});

test("planDraws: B missing + straddling bbox -> partial coverage (false-freeze guard)", () => {
  const bbox: [number, number, number, number] = [1800, 100, 2100, 300];
  const draws = planDraws(bbox, [A]); // B not live
  const w = bbox[2] - bbox[0];
  const h = bbox[3] - bbox[1];
  assert.ok(drawnArea(draws) < w * h);
});

test("planDraws: HiDPI stream doubles the source rect (origin and size) but not the destination", () => {
  const hidpiA = geom(0, 0, 1920, 1080, 3840, 2160); // videoW/H = 2x bounds
  const bbox: [number, number, number, number] = [100, 100, 300, 300];
  const draws = planDraws(bbox, [hidpiA]);
  assert.equal(draws.length, 1);
  assert.equal(draws[0].sx, 100 * 2);
  assert.equal(draws[0].sy, 100 * 2);
  assert.equal(draws[0].sw, (300 - 100) * 2);
  assert.equal(draws[0].dw, 300 - 100);
});

test("planDraws: negative-origin display (macOS-style secondary-left layout)", () => {
  const left = geom(-1920, 0, 1920, 1080); // secondary monitor to the left of origin
  const right = geom(0, 0, 1920, 1080);
  const bbox: [number, number, number, number] = [-1800, 100, -1600, 300];
  const draws = planDraws(bbox, [left, right]);
  assert.equal(draws.length, 1);
  assert.equal(draws[0].i, 0);
  assert.equal(draws[0].sx, -1800 - -1920); // 120: bbox-local to the display origin
  assert.equal(draws[0].dx, 0); // bbox-local to the bbox origin
});

test("unionBounds: side-by-side displays", () => {
  assert.deepEqual(unionBounds([A.display, B.display]), { x: 0, y: 0, width: 3840, height: 1080 });
});

test("unionBounds: negative-origin display included", () => {
  const left = display(-1920, 0, 1920, 1080);
  const right = display(0, 0, 1920, 1080);
  assert.deepEqual(unionBounds([left, right]), { x: -1920, y: 0, width: 3840, height: 1080 });
});

test("bboxCenter of a B-side zone lands past the seam", () => {
  const p = bboxCenter([2000, 100, 2200, 300]);
  assert.ok(p.x > 1920);
  assert.deepEqual(p, { x: 2100, y: 200 });
});

// --- isDisplayCovered -------------------------------------------------------

test("isDisplayCovered: a display with its own live stream is covered", () => {
  assert.equal(isDisplayCovered(A.display, [A, B]), true);
});

test("isDisplayCovered: a display with no live stream is not covered", () => {
  assert.equal(isDisplayCovered(B.display, [A]), false);
});

test("isDisplayCovered: a whole-desktop stream covers every individual display", () => {
  const wholeDesktop: ScreenGeometry = {
    display: { ...A.display, x: 0, y: 0, width: 3840, height: 1080 },
    videoWidth: 3840,
    videoHeight: 1080,
  };
  assert.equal(isDisplayCovered(A.display, [wholeDesktop]), true);
  assert.equal(isDisplayCovered(B.display, [wholeDesktop]), true);
});

test("isDisplayCovered: a gap between two disjoint live displays is not covered", () => {
  const left = geom(0, 0, 1920, 1080);
  const middle = display(1920, 0, 1920, 1080); // never gets its own stream
  const right = geom(3840, 0, 1920, 1080);
  assert.equal(isDisplayCovered(middle, [left, right]), false);
});

// --- looksLikeWholeDesktop ---------------------------------------------------

const union2 = { x: 0, y: 0, width: 3840, height: 1080 };

test("looksLikeWholeDesktop: stream matching the union's width and aspect is the whole desktop", () => {
  assert.equal(looksLikeWholeDesktop(3840, 1080, union2), true);
});

test("looksLikeWholeDesktop: a normal single-display stream is not the whole desktop", () => {
  assert.equal(looksLikeWholeDesktop(1920, 1080, union2), false);
});

test("looksLikeWholeDesktop: aspect-matching but half-width stream (2x2 grid) is rejected", () => {
  // A 2x2 grid of 1920x1080 displays has union 3840x2160 — same aspect ratio
  // as one display (16:9) — so aspect alone would false-positive here.
  const union2x2 = { x: 0, y: 0, width: 3840, height: 2160 };
  assert.equal(looksLikeWholeDesktop(1920, 1080, union2x2), false);
});

test("looksLikeWholeDesktop: zero-size stream never matches", () => {
  assert.equal(looksLikeWholeDesktop(0, 0, union2), false);
});

// --- twoDisplayDirection -----------------------------------------------------

test("twoDisplayDirection: side-by-side displays report LEFT/RIGHT", () => {
  assert.equal(twoDisplayDirection(A.display, B.display), "LEFT");
  assert.equal(twoDisplayDirection(B.display, A.display), "RIGHT");
});

test("twoDisplayDirection: vertically stacked displays (same x) report TOP/BOTTOM", () => {
  const top = display(0, 0, 1920, 1080);
  const bottom = display(0, 1080, 1920, 1080);
  assert.equal(twoDisplayDirection(top, bottom), "TOP");
  assert.equal(twoDisplayDirection(bottom, top), "BOTTOM");
});

test("twoDisplayDirection: identical origin (mirrored displays) is null", () => {
  const a = display(0, 0, 1920, 1080);
  const b = display(0, 0, 1920, 1080);
  assert.equal(twoDisplayDirection(a, b), null);
});
