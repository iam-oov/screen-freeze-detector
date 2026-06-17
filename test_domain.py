"""Assert-based checks for the freeze-detection domain logic.

Run: uv run python test_domain.py

Covers the pure core (ZoneState's freeze state machine, RMSComparator) and the
edge-trigger semantics of FreezeMonitor (sound every frozen tick; inject/notify
once per freeze event) — the logic that defines what the app actually does.
"""

from PIL import Image

from freeze_detector import FreezeMonitor, RMSComparator, ZoneConfig, ZoneState

APPROX = 1e-6


# --------------------------------------------------------------------------
# ZoneState — the freeze state machine
# --------------------------------------------------------------------------


def test_zone_state_accumulates_then_freezes() -> None:
    s = ZoneState()

    # Below threshold never counts and never freezes.
    s.update(0.5, threshold=0.9, consec_required=3)
    assert s.frozen_count == 0 and not s.is_frozen

    # At/above threshold accumulates; threshold is inclusive (>=).
    s.update(0.95, 0.9, 3)
    assert s.frozen_count == 1 and not s.is_frozen
    s.update(0.90, 0.9, 3)  # exactly at threshold still counts
    assert s.frozen_count == 2 and not s.is_frozen
    s.update(1.0, 0.9, 3)  # reaches consec_required
    assert s.frozen_count == 3 and s.is_frozen

    # The latest similarity is recorded.
    assert s.similarity == 1.0


def test_zone_state_single_miss_resets() -> None:
    s = ZoneState()
    s.update(1.0, 0.9, 3)
    s.update(1.0, 0.9, 3)
    assert s.frozen_count == 2
    # One frame below threshold wipes the streak.
    s.update(0.0, 0.9, 3)
    assert s.frozen_count == 0 and not s.is_frozen


def test_zone_state_consec_one_freezes_immediately() -> None:
    s = ZoneState()
    s.update(0.99, 0.9, consec_required=1)
    assert s.is_frozen


def test_zone_state_reset() -> None:
    s = ZoneState()
    s.update(1.0, 0.9, 1)
    s.prev_image = Image.new("RGB", (2, 2))
    assert s.is_frozen
    s.reset()
    assert s.prev_image is None
    assert s.similarity == 0.0
    assert s.frozen_count == 0
    assert not s.is_frozen


# --------------------------------------------------------------------------
# RMSComparator — pixel similarity
# --------------------------------------------------------------------------


def test_rms_identical_is_one() -> None:
    img = Image.new("RGB", (20, 20), (40, 90, 160))
    assert abs(RMSComparator().compute_similarity(img, img) - 1.0) < APPROX


def test_rms_opposite_is_zero() -> None:
    black = Image.new("RGB", (20, 20), (0, 0, 0))
    white = Image.new("RGB", (20, 20), (255, 255, 255))
    assert abs(RMSComparator().compute_similarity(black, white)) < APPROX


def test_rms_resizes_mismatched_sizes() -> None:
    # Different sizes, same solid color -> resize makes them identical -> 1.0.
    small = Image.new("RGB", (10, 10), (50, 50, 50))
    big = Image.new("RGB", (30, 20), (50, 50, 50))
    assert abs(RMSComparator().compute_similarity(small, big) - 1.0) < APPROX


def test_rms_partial_is_bounded_and_symmetric() -> None:
    cmp = RMSComparator()
    a = Image.new("RGB", (20, 20), (0, 0, 0))
    b = Image.new("RGB", (20, 20), (128, 128, 128))
    s = cmp.compute_similarity(a, b)
    assert 0.0 < s < 1.0
    # difference is symmetric, so order must not matter
    assert abs(cmp.compute_similarity(a, b) - cmp.compute_similarity(b, a)) < APPROX


# --------------------------------------------------------------------------
# FreezeMonitor — edge-trigger orchestration
# --------------------------------------------------------------------------


class _Capturer:
    def grab_region(self, bbox):
        return Image.new("RGB", (4, 4))


class _AlwaysFrozenComparator:
    def compute_similarity(self, a, b):
        return 1.0


class _Sound:
    def __init__(self):
        self.plays = 0

    def play(self):
        self.plays += 1

    def cleanup(self):
        pass


class _Injector:
    def __init__(self):
        self.injected = []

    def inject(self, bbox=None):
        self.injected.append(bbox)

    def type_text(self, text, bbox=None):
        pass


class _Notifier:
    def __init__(self):
        self.sent = []

    def notify_frozen(self, image, name):
        self.sent.append(name)


def _run(monitor, zones, states, n, threshold=0.9, consec=2):
    for _ in range(n):
        monitor.check_zones(zones, states, threshold, consec)


def test_freeze_monitor_inject_and_notify_are_edge_triggered() -> None:
    sound, inj, notifier = _Sound(), _Injector(), _Notifier()
    monitor = FreezeMonitor(_Capturer(), _AlwaysFrozenComparator(), sound, inj, notifier)
    zones = [ZoneConfig(bbox=(0, 0, 10, 10), name="Zone 1")]
    states = [ZoneState()]

    # 4 ticks, consec=2: tick1 seeds prev_image, tick2 count=1, tick3 freezes
    # (edge), tick4 stays frozen.
    _run(monitor, zones, states, 4, consec=2)

    # Sound plays on every frozen tick (tick3 + tick4).
    assert sound.plays == 2
    # Enter + Telegram fire exactly once, on the freeze edge.
    assert inj.injected == [(0, 0, 10, 10)]
    assert notifier.sent == ["Zone 1"]


def test_freeze_monitor_respects_per_zone_sound_toggle() -> None:
    sound, inj, notifier = _Sound(), _Injector(), _Notifier()
    monitor = FreezeMonitor(_Capturer(), _AlwaysFrozenComparator(), sound, inj, notifier)
    zones = [ZoneConfig(bbox=(0, 0, 10, 10), name="Zone 1", sound_enabled=False)]
    states = [ZoneState()]

    _run(monitor, zones, states, 4, consec=2)

    # Sound is muted for this zone...
    assert sound.plays == 0
    # ...but the Enter/Telegram edge still fires (independent of sound).
    assert inj.injected == [(0, 0, 10, 10)]
    assert notifier.sent == ["Zone 1"]


def test_freeze_monitor_skips_disabled_zone() -> None:
    sound, inj, notifier = _Sound(), _Injector(), _Notifier()
    monitor = FreezeMonitor(_Capturer(), _AlwaysFrozenComparator(), sound, inj, notifier)
    zones = [ZoneConfig(bbox=(0, 0, 10, 10), name="Zone 1", enabled=False)]
    states = [ZoneState()]

    _run(monitor, zones, states, 4, consec=2)

    assert sound.plays == 0
    assert inj.injected == []
    assert notifier.sent == []
    assert states[0].prev_image is None  # never captured


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
    print(f"ok ({len(fns)} tests)")
