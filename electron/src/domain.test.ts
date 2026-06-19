// Mirrors test_domain.py 1:1. Run: node --test (see package.json).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ZoneConfig,
  ZoneState,
  RMSComparator,
  FreezeMonitor,
  stateKind,
  type Bbox,
  type PixelFrame,
} from "./domain.ts";

const APPROX = 1e-6;

function solid(w: number, h: number, r: number, g: number, b: number): PixelFrame {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  }
  return { width: w, height: h, data };
}

// --- ZoneState — the freeze state machine ---------------------------------

test("zone_state accumulates then freezes", () => {
  const s = new ZoneState();

  s.update(0.5, 0.9, 3); // below threshold never counts
  assert.equal(s.frozenCount, 0);
  assert.equal(s.isFrozen, false);

  s.update(0.95, 0.9, 3);
  assert.equal(s.frozenCount, 1);
  assert.equal(s.isFrozen, false);
  s.update(0.9, 0.9, 3); // exactly at threshold still counts (>=)
  assert.equal(s.frozenCount, 2);
  assert.equal(s.isFrozen, false);
  s.update(1.0, 0.9, 3); // reaches consecRequired
  assert.equal(s.frozenCount, 3);
  assert.equal(s.isFrozen, true);

  assert.equal(s.similarity, 1.0);
});

test("zone_state single miss resets", () => {
  const s = new ZoneState();
  s.update(1.0, 0.9, 3);
  s.update(1.0, 0.9, 3);
  assert.equal(s.frozenCount, 2);
  s.update(0.0, 0.9, 3); // one frame below threshold wipes the streak
  assert.equal(s.frozenCount, 0);
  assert.equal(s.isFrozen, false);
});

test("zone_state consec one freezes immediately", () => {
  const s = new ZoneState();
  s.update(0.99, 0.9, 1);
  assert.equal(s.isFrozen, true);
});

test("zone_state reset", () => {
  const s = new ZoneState();
  s.update(1.0, 0.9, 1);
  s.prevImage = solid(2, 2, 0, 0, 0);
  assert.equal(s.isFrozen, true);
  s.reset();
  assert.equal(s.prevImage, null);
  assert.equal(s.similarity, 0.0);
  assert.equal(s.frozenCount, 0);
  assert.equal(s.isFrozen, false);
});

// --- stateKind — visual/summary state label -------------------------------

test("state_kind maps state to ok/warn/frozen by threshold", () => {
  const s = new ZoneState();
  const thr = 0.997;

  s.similarity = 0.5;
  assert.equal(stateKind(s, thr), "ok"); // well below threshold -> green

  s.similarity = 0.99; // below threshold -> still green
  assert.equal(stateKind(s, thr), "ok");

  s.similarity = thr; // exactly at threshold counts (>=) -> yellow
  assert.equal(stateKind(s, thr), "warn");

  s.similarity = 0.999; // above threshold -> yellow
  assert.equal(stateKind(s, thr), "warn");

  s.isFrozen = true; // frozen wins regardless of similarity
  s.similarity = 0.0;
  assert.equal(stateKind(s, thr), "frozen");
});

// --- RMSComparator — pixel similarity -------------------------------------

test("rms identical is one", () => {
  const img = solid(20, 20, 40, 90, 160);
  assert.ok(Math.abs(new RMSComparator().computeSimilarity(img, img) - 1.0) < APPROX);
});

test("rms opposite is zero", () => {
  const black = solid(20, 20, 0, 0, 0);
  const white = solid(20, 20, 255, 255, 255);
  assert.ok(Math.abs(new RMSComparator().computeSimilarity(black, white)) < APPROX);
});

test("rms partial is bounded and symmetric", () => {
  const cmp = new RMSComparator();
  const a = solid(20, 20, 0, 0, 0);
  const b = solid(20, 20, 128, 128, 128);
  const s = cmp.computeSimilarity(a, b);
  assert.ok(s > 0.0 && s < 1.0);
  assert.ok(Math.abs(cmp.computeSimilarity(a, b) - cmp.computeSimilarity(b, a)) < APPROX);
});

test("rms throws on mismatched sizes (equal-dimensions contract)", () => {
  // Replaces the Python resize test: in Electron both frames are same-size
  // canvas crops, so a size mismatch is a programming error, not a resize.
  const small = solid(10, 10, 50, 50, 50);
  const big = solid(30, 20, 50, 50, 50);
  assert.throws(() => new RMSComparator().computeSimilarity(small, big));
});

// --- FreezeMonitor — edge-trigger orchestration ---------------------------

class FakeCapturer {
  grabRegion(_bbox: Bbox): PixelFrame {
    return solid(4, 4, 0, 0, 0);
  }
}
class AlwaysFrozenComparator {
  computeSimilarity(_a: PixelFrame, _b: PixelFrame): number {
    return 1.0;
  }
}
class FakeSound {
  plays = 0;
  play(): void {
    this.plays += 1;
  }
}
class FakeInjector {
  injected: Array<Bbox | undefined> = [];
  inject(bbox?: Bbox): void {
    this.injected.push(bbox);
  }
}
class FakeNotifier {
  sent: string[] = [];
  notifyFrozen(_frame: PixelFrame, name: string): void {
    this.sent.push(name);
  }
}

function run(monitor: FreezeMonitor, zones: ZoneConfig[], states: ZoneState[], n: number, consec = 2): void {
  for (let i = 0; i < n; i++) {
    monitor.checkZones(zones, states, 0.9, consec);
  }
}

test("freeze_monitor inject and notify are edge-triggered", () => {
  const sound = new FakeSound();
  const inj = new FakeInjector();
  const notifier = new FakeNotifier();
  const monitor = new FreezeMonitor(new FakeCapturer(), new AlwaysFrozenComparator(), sound, inj, notifier);
  // injectEnabled=true so Enter fires (it is per-zone and off by default).
  const zones = [new ZoneConfig([0, 0, 10, 10], "Zone 1", true, true, true)];
  const states = [new ZoneState()];

  // 4 ticks, consec=2: tick1 seeds prevImage, tick2 count=1, tick3 freezes
  // (edge), tick4 stays frozen.
  run(monitor, zones, states, 4, 2);

  assert.equal(sound.plays, 2); // every frozen tick (tick3 + tick4)
  assert.deepEqual(inj.injected, [[0, 0, 10, 10]]); // edge only
  assert.deepEqual(notifier.sent, ["Zone 1"]);
});

test("freeze_monitor respects per-zone inject toggle", () => {
  const sound = new FakeSound();
  const inj = new FakeInjector();
  const notifier = new FakeNotifier();
  const monitor = new FreezeMonitor(new FakeCapturer(), new AlwaysFrozenComparator(), sound, inj, notifier);
  const zones = [new ZoneConfig([0, 0, 10, 10], "Zone 1")]; // injectEnabled defaults false
  const states = [new ZoneState()];

  run(monitor, zones, states, 4, 2);

  assert.deepEqual(inj.injected, []); // Enter off -> no injection...
  assert.equal(sound.plays, 2); // ...but sound + notify still fire
  assert.deepEqual(notifier.sent, ["Zone 1"]);
});

test("freeze_monitor respects per-zone sound toggle", () => {
  const sound = new FakeSound();
  const inj = new FakeInjector();
  const notifier = new FakeNotifier();
  const monitor = new FreezeMonitor(new FakeCapturer(), new AlwaysFrozenComparator(), sound, inj, notifier);
  // soundEnabled=false, injectEnabled=true
  const zones = [new ZoneConfig([0, 0, 10, 10], "Zone 1", true, false, true)];
  const states = [new ZoneState()];

  run(monitor, zones, states, 4, 2);

  assert.equal(sound.plays, 0); // muted...
  assert.deepEqual(inj.injected, [[0, 0, 10, 10]]); // ...but edge still fires
  assert.deepEqual(notifier.sent, ["Zone 1"]);
});

test("freeze_monitor skips disabled zone", () => {
  const sound = new FakeSound();
  const inj = new FakeInjector();
  const notifier = new FakeNotifier();
  const monitor = new FreezeMonitor(new FakeCapturer(), new AlwaysFrozenComparator(), sound, inj, notifier);
  const zones = [new ZoneConfig([0, 0, 10, 10], "Zone 1", false)]; // enabled=false
  const states = [new ZoneState()];

  run(monitor, zones, states, 4, 2);

  assert.equal(sound.plays, 0);
  assert.deepEqual(inj.injected, []);
  assert.deepEqual(notifier.sent, []);
  assert.equal(states[0].prevImage, null); // never captured
});
