"""Screen Freeze Detector - Detects when screen zones freeze."""

import io
import math
import os
import struct
import subprocess
import tempfile
import time
import tkinter as tk
from dataclasses import dataclass
from tkinter import ttk
from typing import Protocol
import wave

from PIL import Image, ImageChops, ImageStat

try:
    from PIL import ImageTk

    HAS_IMAGETK = True
except ImportError:
    HAS_IMAGETK = False

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VERSION = "1.2.0"

SELECTION_COLOR = "#39FF14"

DEFAULT_THRESHOLD = 0.995
DEFAULT_INTERVAL_MS = 5000
DEFAULT_CONSECUTIVE_FRAMES = 4

ALERT_FREQUENCY = 880
ALERT_DURATION = 0.15
ALERT_BEEPS = 2
ALERT_GAP = 0.1
ALERT_COOLDOWN = DEFAULT_INTERVAL_MS / 1000

ZONE_COLORS = [
    "#FF4444",
    "#44FF44",
    "#4444FF",
    "#FFFF44",
    "#FF44FF",
    "#44FFFF",
    "#FF8844",
    "#88FF44",
]

# Theme — dark navy + orange accent (inspired by modern agency landing pages)
BG = "#141422"
BG_SURFACE = "#1c1c30"
BG_CARD = "#1e1e34"
BG_INPUT = "#2a2a44"
FG = "#e8e8f0"
FG_DIM = "#6a6a80"
FG_BRIGHT = "#ffffff"
ACCENT = "#e8651a"
ACCENT_HOVER = "#cc5510"
GREEN = "#4ade80"
RED = "#ef4444"
YELLOW = "#eab308"
BORDER = "#2e2e48"
FONT = "sans-serif"


# ---------------------------------------------------------------------------
# Protocols (Dependency Inversion)
# ---------------------------------------------------------------------------


class ScreenCapturer(Protocol):
    def grab_fullscreen(self) -> Image.Image: ...
    def grab_region(self, bbox: tuple[int, int, int, int]) -> Image.Image: ...


class SoundPlayer(Protocol):
    def play(self) -> None: ...
    def cleanup(self) -> None: ...


class HotkeyListener(Protocol):
    def start(self) -> None: ...
    def stop(self) -> None: ...


class ImageComparator(Protocol):
    def compute_similarity(self, img1: Image.Image, img2: Image.Image) -> float: ...


# ---------------------------------------------------------------------------
# Infrastructure implementations
# ---------------------------------------------------------------------------


class ScrotCapturer:
    def _capture_to_image(self, args: list[str]) -> Image.Image:
        fd, path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            subprocess.run(args + ["-o", path], check=True, capture_output=True)
            return Image.open(path).copy()
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    def grab_fullscreen(self) -> Image.Image:
        return self._capture_to_image(["scrot"])

    def grab_region(self, bbox: tuple[int, int, int, int]) -> Image.Image:
        left, top, right, bottom = bbox
        w, h = right - left, bottom - top
        return self._capture_to_image(["scrot", "-a", f"{left},{top},{w},{h}"])


class AplaySound:
    def __init__(
        self,
        frequency: int = ALERT_FREQUENCY,
        duration: float = ALERT_DURATION,
        beeps: int = ALERT_BEEPS,
        gap: float = ALERT_GAP,
        cooldown: float = ALERT_COOLDOWN,
    ):
        self._wav_path = self._generate_wav(frequency, duration, beeps, gap)
        self._process: subprocess.Popen | None = None
        self._cooldown = cooldown
        self._last_play = 0.0

    def _generate_wav(self, freq: int, duration: float, beeps: int, gap: float) -> str:
        sample_rate = 44100
        amplitude = 20000
        samples: list[int] = []
        beep_samples = int(sample_rate * duration)
        gap_samples = int(sample_rate * gap)

        for i in range(beeps):
            for s in range(beep_samples):
                t = s / sample_rate
                value = int(amplitude * math.sin(2 * math.pi * freq * t))
                samples.append(value)
            if i < beeps - 1:
                samples.extend([0] * gap_samples)

        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)

        with wave.open(path, "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(struct.pack(f"<{len(samples)}h", *samples))

        return path

    def play(self) -> None:
        now = time.time()
        if now - self._last_play < self._cooldown:
            return
        if self._process and self._process.poll() is None:
            return
        self._process = subprocess.Popen(
            ["aplay", "-q", self._wav_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self._last_play = now

    def cleanup(self) -> None:
        if self._process and self._process.poll() is None:
            self._process.terminate()
        try:
            os.unlink(self._wav_path)
        except OSError:
            pass


class RMSComparator:
    def compute_similarity(self, img1: Image.Image, img2: Image.Image) -> float:
        if img1.size != img2.size:
            img2 = img2.resize(img1.size)
        diff = ImageChops.difference(img1.convert("RGB"), img2.convert("RGB"))
        stat = ImageStat.Stat(diff)
        rms = math.sqrt(sum(x**2 for x in stat.rms) / len(stat.rms))
        return 1.0 - (rms / 255.0)


class PynputHotkeys:
    def __init__(self, on_start: callable, on_stop: callable):
        from pynput import keyboard

        self._on_start = on_start
        self._on_stop = on_stop
        self._listener = keyboard.Listener(on_press=self._on_key_press)

    def _on_key_press(self, key) -> None:
        from pynput import keyboard

        if key == keyboard.Key.f11:
            self._on_start()
        elif key == keyboard.Key.f12:
            self._on_stop()

    def start(self) -> None:
        self._listener.start()

    def stop(self) -> None:
        self._listener.stop()


# ---------------------------------------------------------------------------
# Domain
# ---------------------------------------------------------------------------


@dataclass
class ZoneConfig:
    bbox: tuple[int, int, int, int]
    name: str
    enabled: bool = True


@dataclass
class ZoneState:
    prev_image: Image.Image | None = None
    similarity: float = 0.0
    frozen_count: int = 0
    is_frozen: bool = False

    def update(self, similarity: float, threshold: float, consec_required: int) -> None:
        self.similarity = similarity
        if similarity >= threshold:
            self.frozen_count += 1
        else:
            self.frozen_count = 0
        self.is_frozen = self.frozen_count >= consec_required

    def reset(self) -> None:
        self.prev_image = None
        self.similarity = 0.0
        self.frozen_count = 0
        self.is_frozen = False


class FreezeMonitor:
    def __init__(
        self, capturer: ScreenCapturer, comparator: ImageComparator, sound: SoundPlayer
    ):
        self._capturer = capturer
        self._comparator = comparator
        self._sound = sound

    def check_zones(
        self,
        zones: list[ZoneConfig],
        states: list[ZoneState],
        threshold: float,
        consec_required: int,
    ) -> list[tuple[int, Image.Image | None]]:
        results: list[tuple[int, Image.Image | None]] = []

        for i, (zone, state) in enumerate(zip(zones, states)):
            if not zone.enabled:
                results.append((i, None))
                continue
            try:
                new_img = self._capturer.grab_region(bbox=zone.bbox)
            except Exception:
                results.append((i, None))
                continue

            if state.prev_image is not None:
                similarity = self._comparator.compute_similarity(
                    state.prev_image, new_img
                )
                state.update(similarity, threshold, consec_required)
                if state.is_frozen:
                    self._sound.play()

            state.prev_image = new_img
            results.append((i, new_img))

        return results


# ---------------------------------------------------------------------------
# UI helpers
# ---------------------------------------------------------------------------


def pil_to_tk(image: Image.Image) -> tk.PhotoImage:
    if HAS_IMAGETK:
        return ImageTk.PhotoImage(image)
    buf = io.BytesIO()
    image.save(buf, format="PPM")
    return tk.PhotoImage(data=buf.getvalue())


def generate_app_icon() -> Image.Image:
    """Generate a 64x64 app icon using the theme palette."""
    from PIL import ImageDraw, ImageFont

    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    draw.ellipse([2, 2, size - 3, size - 3], fill=ACCENT, outline=ACCENT_HOVER, width=2)

    try:
        font = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 32
        )
    except OSError:
        font = ImageFont.load_default()
    draw.text((size // 2, size // 2), "S", fill="#ffffff", font=font, anchor="mm")

    return img


def setup_theme(root: tk.Tk) -> None:
    root.configure(bg=BG)
    root.option_add("*Background", BG)
    root.option_add("*Foreground", FG)
    root.option_add("*Font", f"{FONT} 10")
    root.option_add("*Checkbutton.selectColor", BG_INPUT)
    root.option_add("*Checkbutton.activeBackground", BG_SURFACE)
    root.option_add("*Checkbutton.activeForeground", FG)

    style = ttk.Style(root)
    style.theme_use("clam")

    # Base
    style.configure(".", background=BG, foreground=FG, font=(FONT, 10))
    style.configure("TFrame", background=BG)
    style.configure("TLabel", background=BG, foreground=FG, font=(FONT, 10))

    # Section headers — orange label, thin separator feel
    style.configure(
        "TLabelframe",
        background=BG,
        foreground=FG_DIM,
        bordercolor=BORDER,
        lightcolor=BORDER,
        darkcolor=BORDER,
    )
    style.configure(
        "TLabelframe.Label", background=BG, foreground=ACCENT, font=(FONT, 9)
    )

    style.configure("TCheckbutton", background=BG, foreground=FG_DIM)
    style.map(
        "TCheckbutton", background=[("active", BG_SURFACE)], foreground=[("active", FG)]
    )

    # Buttons — outlined style: dark bg, orange border, white uppercase text
    style.configure(
        "TButton",
        background=BG_SURFACE,
        foreground=FG,
        font=(FONT, 9),
        padding=(16, 7),
        bordercolor=FG_DIM,
        lightcolor=FG_DIM,
        darkcolor=FG_DIM,
        borderwidth=1,
    )
    style.map(
        "TButton",
        background=[("active", BG_INPUT), ("disabled", BG)],
        foreground=[("active", FG_BRIGHT), ("disabled", FG_DIM)],
        bordercolor=[("active", ACCENT)],
        lightcolor=[("active", ACCENT)],
        darkcolor=[("active", ACCENT)],
    )

    # Active toggle — orange filled
    style.configure(
        "Active.TButton",
        background=ACCENT,
        foreground="#0a0a0a",
        font=(FONT, 9, "bold"),
        padding=(16, 7),
        bordercolor=ACCENT,
        lightcolor=ACCENT,
        darkcolor=ACCENT,
    )
    style.map(
        "Active.TButton",
        background=[("active", ACCENT_HOVER)],
        foreground=[("active", "#0a0a0a")],
    )

    # Cards
    style.configure("Card.TFrame", background=BG_CARD)
    style.configure("Card.TLabel", background=BG_CARD, foreground=FG)
    style.configure(
        "CardDim.TLabel", background=BG_CARD, foreground=FG_DIM, font=(FONT, 9)
    )
    style.configure(
        "CardBold.TLabel",
        background=BG_CARD,
        foreground=FG_BRIGHT,
        font=(FONT, 11, "bold"),
    )
    style.configure(
        "Frozen.TLabel", background=BG_CARD, foreground=RED, font=(FONT, 10, "bold")
    )
    style.configure(
        "OK.TLabel", background=BG_CARD, foreground=GREEN, font=(FONT, 10, "bold")
    )
    style.configure("Card.TCheckbutton", background=BG_CARD, foreground=FG_DIM)
    style.map(
        "Card.TCheckbutton",
        background=[("active", BG_CARD)],
        foreground=[("active", FG)],
    )

    # Status bar
    style.configure(
        "StatusBar.TLabel",
        background=BG_SURFACE,
        foreground=FG_DIM,
        font=(FONT, 9),
        padding=(10, 5),
    )

    # Empty state
    style.configure("Empty.TLabel", background=BG, foreground=FG_DIM, font=(FONT, 11))

    # Progress bars — thin, clean
    style.configure(
        "Sim.Horizontal.TProgressbar",
        troughcolor=BG_INPUT,
        background=GREEN,
        thickness=6,
        bordercolor=BG_INPUT,
        lightcolor=GREEN,
        darkcolor=GREEN,
    )
    style.configure(
        "SimWarn.Horizontal.TProgressbar",
        troughcolor=BG_INPUT,
        background=YELLOW,
        thickness=6,
        bordercolor=BG_INPUT,
        lightcolor=YELLOW,
        darkcolor=YELLOW,
    )
    style.configure(
        "SimFrozen.Horizontal.TProgressbar",
        troughcolor=BG_INPUT,
        background=RED,
        thickness=6,
        bordercolor=BG_INPUT,
        lightcolor=RED,
        darkcolor=RED,
    )

    # Sliders
    style.configure(
        "Horizontal.TScale",
        background=BG,
        troughcolor=BG_INPUT,
        sliderthickness=12,
        bordercolor=BG_INPUT,
        lightcolor=ACCENT,
        darkcolor=ACCENT,
    )
    style.map("Horizontal.TScale", background=[("active", ACCENT)])


# ---------------------------------------------------------------------------
# ZoneSelector
# ---------------------------------------------------------------------------


class ZoneSelector(tk.Toplevel):
    MIN_RECT_SIZE = 20

    def __init__(self, master: tk.Tk, capturer: ScreenCapturer, callback):
        super().__init__(master)

        self._callback = callback
        self._zones: list[ZoneConfig] = []
        self._rect_ids: list[int] = []
        self._label_ids: list[int] = []
        self._current_rect: int | None = None
        self._start_x = 0
        self._start_y = 0

        master.withdraw()
        self.withdraw()
        self.update_idletasks()
        time.sleep(0.3)

        self._screenshot = capturer.grab_fullscreen()
        master.deiconify()

        self.overrideredirect(True)
        self.attributes("-topmost", True)
        screen_w = self._screenshot.width
        screen_h = self._screenshot.height
        self.geometry(f"{screen_w}x{screen_h}+0+0")

        self._canvas = tk.Canvas(
            self,
            width=screen_w,
            height=screen_h,
            highlightthickness=0,
            cursor="crosshair",
        )
        self._canvas.pack(fill=tk.BOTH, expand=True)

        self._bg_photo = pil_to_tk(self._screenshot)
        self._canvas.create_image(0, 0, anchor=tk.NW, image=self._bg_photo)

        self._canvas.create_rectangle(
            0, 0, screen_w, 50, fill="#000000", stipple="gray50", outline=""
        )

        instr = "Drag to draw zones  |  Right click: undo  |  Enter: confirm  |  Escape: cancel"
        self._canvas.create_text(
            screen_w // 2 + 1, 26, text=instr, fill="#000000", font=(FONT, 13, "bold")
        )
        self._canvas.create_text(
            screen_w // 2, 25, text=instr, fill="#ffffff", font=(FONT, 13, "bold")
        )

        self._canvas.bind("<ButtonPress-1>", self._on_press)
        self._canvas.bind("<B1-Motion>", self._on_drag)
        self._canvas.bind("<ButtonRelease-1>", self._on_release)
        self._canvas.bind("<Button-3>", self._on_right_click)
        self.bind("<Return>", self._on_confirm)
        self.bind("<Escape>", self._on_cancel)

        self.focus_force()
        self.grab_set()
        self.deiconify()

    def _color(self, idx: int) -> str:
        return ZONE_COLORS[idx % len(ZONE_COLORS)]

    def _on_press(self, event: tk.Event) -> None:
        self._start_x = event.x
        self._start_y = event.y
        self._current_rect = self._canvas.create_rectangle(
            event.x,
            event.y,
            event.x,
            event.y,
            outline=SELECTION_COLOR,
            dash=(4, 4),
            width=2,
        )

    def _on_drag(self, event: tk.Event) -> None:
        if self._current_rect is not None:
            self._canvas.coords(
                self._current_rect, self._start_x, self._start_y, event.x, event.y
            )

    def _on_release(self, event: tk.Event) -> None:
        if self._current_rect is None:
            return
        x1, y1 = self._start_x, self._start_y
        x2, y2 = event.x, event.y
        left, right = min(x1, x2), max(x1, x2)
        top, bottom = min(y1, y2), max(y1, y2)

        self._canvas.delete(self._current_rect)
        self._current_rect = None

        if (right - left) < self.MIN_RECT_SIZE or (bottom - top) < self.MIN_RECT_SIZE:
            return

        idx = len(self._zones)
        color = self._color(idx)
        name = f"Zone {idx + 1}"

        self._zones.append(ZoneConfig(bbox=(left, top, right, bottom), name=name))
        self._rect_ids.append(
            self._canvas.create_rectangle(
                left, top, right, bottom, outline=color, width=3
            )
        )
        self._label_ids.append(
            self._canvas.create_text(
                left + 5,
                top + 5,
                text=name,
                anchor=tk.NW,
                fill=color,
                font=(FONT, 12, "bold"),
            )
        )

    def _on_right_click(self, event: tk.Event) -> None:
        if not self._zones:
            return
        self._zones.pop()
        if self._rect_ids:
            self._canvas.delete(self._rect_ids.pop())
        if self._label_ids:
            self._canvas.delete(self._label_ids.pop())

    def _on_confirm(self, event: tk.Event) -> None:
        zones, screenshot = list(self._zones), self._screenshot
        self.grab_release()
        self.destroy()
        self._callback(zones, screenshot)

    def _on_cancel(self, event: tk.Event) -> None:
        self.grab_release()
        self.destroy()
        self._callback([], None)


# ---------------------------------------------------------------------------
# ZoneMonitorWidget
# ---------------------------------------------------------------------------


class ZoneMonitorWidget(ttk.Frame):
    THUMB_W = 140
    THUMB_H = 90

    def __init__(self, master: tk.Widget, zone: ZoneConfig, zone_index: int, on_remove):
        super().__init__(master, style="Card.TFrame", padding=10)

        self._zone = zone
        self._photo: tk.PhotoImage | None = None
        color = ZONE_COLORS[zone_index % len(ZONE_COLORS)]

        # --- Header ---
        header = ttk.Frame(self, style="Card.TFrame")
        header.pack(fill=tk.X, pady=(0, 6))

        self._dot_canvas = tk.Canvas(
            header, width=12, height=12, bg=BG_CARD, highlightthickness=0
        )
        self._dot_canvas.pack(side=tk.LEFT, padx=(0, 6))
        self._dot = self._dot_canvas.create_oval(2, 2, 10, 10, fill=FG_DIM, outline="")

        ttk.Label(header, text=zone.name, style="CardBold.TLabel").pack(side=tk.LEFT)

        dims = f"{zone.bbox[2] - zone.bbox[0]}x{zone.bbox[3] - zone.bbox[1]}"
        ttk.Label(header, text=dims, style="CardDim.TLabel").pack(
            side=tk.LEFT, padx=(8, 0)
        )

        tk.Button(
            header,
            text="X",
            command=on_remove,
            bg=BG_CARD,
            fg=FG_DIM,
            activebackground=BG_CARD,
            activeforeground=RED,
            relief=tk.FLAT,
            font=(FONT, 9),
            width=3,
            cursor="hand2",
            bd=0,
            highlightthickness=0,
        ).pack(side=tk.RIGHT)

        # --- Body ---
        body = ttk.Frame(self, style="Card.TFrame")
        body.pack(fill=tk.X)

        thumb_border = tk.Frame(body, bg=BORDER, padx=1, pady=1)
        thumb_border.pack(side=tk.LEFT, padx=(0, 12))
        self._thumb_label = tk.Label(
            thumb_border,
            width=self.THUMB_W,
            height=self.THUMB_H,
            bg=BG_INPUT,
            highlightthickness=0,
        )
        self._thumb_label.pack()

        info = ttk.Frame(body, style="Card.TFrame")
        info.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # Similarity
        sim_header = ttk.Frame(info, style="Card.TFrame")
        sim_header.pack(fill=tk.X, pady=(2, 0))
        ttk.Label(sim_header, text="Similarity", style="CardDim.TLabel").pack(
            side=tk.LEFT
        )
        self._sim_pct = ttk.Label(sim_header, text="--", style="CardDim.TLabel")
        self._sim_pct.pack(side=tk.RIGHT)

        self._sim_var = tk.DoubleVar(value=0)
        self._sim_bar = ttk.Progressbar(
            info,
            variable=self._sim_var,
            maximum=100,
            style="Sim.Horizontal.TProgressbar",
            length=200,
        )
        self._sim_bar.pack(fill=tk.X, pady=(2, 6))

        # Status
        self._status_label = ttk.Label(info, text="Waiting...", style="Card.TLabel")
        self._status_label.pack(anchor=tk.W)

        self._frozen_label = ttk.Label(
            info, text="Frozen frames: 0", style="CardDim.TLabel"
        )
        self._frozen_label.pack(anchor=tk.W, pady=(2, 4))

        # Enabled
        self._enabled_var = tk.BooleanVar(value=zone.enabled)
        self._enabled_var.trace_add("write", self._on_enabled_changed)
        ttk.Checkbutton(
            info, text="Enabled", variable=self._enabled_var, style="Card.TCheckbutton"
        ).pack(anchor=tk.W)

    def _on_enabled_changed(self, *_args) -> None:
        self._zone.enabled = self._enabled_var.get()

    def update_display(
        self, state: ZoneState, image: Image.Image | None = None
    ) -> None:
        if image is not None:
            thumb = image.resize((self.THUMB_W, self.THUMB_H), Image.LANCZOS)
            self._photo = pil_to_tk(thumb)
            self._thumb_label.configure(image=self._photo)

        pct = state.similarity * 100
        self._sim_var.set(pct)
        self._sim_pct.configure(text=f"{pct:.1f}%")

        if state.is_frozen:
            self._status_label.configure(text="FROZEN", style="Frozen.TLabel")
            self._dot_canvas.itemconfig(self._dot, fill=RED)
            self._sim_bar.configure(style="SimFrozen.Horizontal.TProgressbar")
        elif pct >= 90:
            self._status_label.configure(text="OK", style="OK.TLabel")
            self._dot_canvas.itemconfig(self._dot, fill=YELLOW)
            self._sim_bar.configure(style="SimWarn.Horizontal.TProgressbar")
        else:
            self._status_label.configure(text="OK", style="OK.TLabel")
            self._dot_canvas.itemconfig(self._dot, fill=GREEN)
            self._sim_bar.configure(style="Sim.Horizontal.TProgressbar")

        self._frozen_label.configure(text=f"Frozen frames: {state.frozen_count}")


# ---------------------------------------------------------------------------
# FreezeDetectorApp
# ---------------------------------------------------------------------------


class FreezeDetectorApp:
    def __init__(
        self,
        root: tk.Tk,
        capturer: ScreenCapturer,
        sound: SoundPlayer,
        monitor: FreezeMonitor,
        hotkeys: HotkeyListener,
    ):
        self.root = root
        self.root.title(f"Screen Freeze Detector v{VERSION}")
        self.root.geometry("540x660")
        self.root.minsize(440, 460)

        self._icon = pil_to_tk(generate_app_icon())
        self.root.iconphoto(True, self._icon)

        self._capturer = capturer
        self._sound = sound
        self._monitor = monitor
        self._hotkeys = hotkeys

        self.zones: list[ZoneConfig] = []
        self.states: list[ZoneState] = []
        self.widgets: list[ZoneMonitorWidget] = []
        self.is_monitoring = False
        self._after_id: str | None = None

        setup_theme(root)
        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self._hotkeys.start()

    def _build_ui(self) -> None:
        main = ttk.Frame(self.root)
        main.pack(fill=tk.BOTH, expand=True)

        # --- Toolbar ---
        toolbar = ttk.Frame(main)
        toolbar.pack(fill=tk.X, padx=12, pady=(12, 8))

        self._select_btn = ttk.Button(
            toolbar,
            text="Select Zones",
            command=self._select_zones,
        )
        self._select_btn.pack(side=tk.LEFT, padx=(0, 4))

        self._monitor_btn = ttk.Button(
            toolbar,
            text="Start (F11)",
            command=self._toggle_monitoring,
        )
        self._monitor_btn.pack(side=tk.LEFT, padx=4)

        self._preview_btn = ttk.Button(
            toolbar,
            text="Show Zones",
            command=self._toggle_preview,
        )
        self._preview_btn.pack(side=tk.RIGHT, padx=3)
        self._preview_window: tk.Toplevel | None = None
        self._preview_photo: tk.PhotoImage | None = None

        # --- Settings ---
        settings = ttk.LabelFrame(main, text="  Settings  ", padding=10)
        settings.pack(fill=tk.X, padx=12, pady=(0, 8))

        row1 = ttk.Frame(settings)
        row1.pack(fill=tk.X, pady=3)
        ttk.Label(row1, text="Threshold").pack(side=tk.LEFT)
        self._threshold_var = tk.DoubleVar(value=DEFAULT_THRESHOLD)
        self._threshold_label = ttk.Label(row1, text=f"{DEFAULT_THRESHOLD * 100:.1f}%")
        self._threshold_label.pack(side=tk.RIGHT)
        ttk.Scale(
            row1,
            from_=0.90,
            to=1.00,
            variable=self._threshold_var,
            command=self._on_threshold_changed,
        ).pack(side=tk.LEFT, fill=tk.X, expand=True, padx=12)

        row2 = ttk.Frame(settings)
        row2.pack(fill=tk.X, pady=3)
        ttk.Label(row2, text="Interval").pack(side=tk.LEFT)
        self._interval_var = tk.IntVar(value=DEFAULT_INTERVAL_MS)
        self._interval_label = ttk.Label(row2, text=f"{DEFAULT_INTERVAL_MS}ms")
        self._interval_label.pack(side=tk.RIGHT)
        ttk.Scale(
            row2,
            from_=500,
            to=5000,
            variable=self._interval_var,
            command=self._on_interval_changed,
        ).pack(side=tk.LEFT, fill=tk.X, expand=True, padx=12)

        row3 = ttk.Frame(settings)
        row3.pack(fill=tk.X, pady=3)
        ttk.Label(row3, text="Consec. frames").pack(side=tk.LEFT)
        self._consec_var = tk.IntVar(value=DEFAULT_CONSECUTIVE_FRAMES)
        tk.Spinbox(
            row3,
            from_=1,
            to=10,
            textvariable=self._consec_var,
            width=4,
            bg=BG_INPUT,
            fg=FG,
            buttonbackground=BG_SURFACE,
            insertbackground=FG,
            relief=tk.FLAT,
            highlightthickness=1,
            highlightcolor=ACCENT,
            highlightbackground=BORDER,
        ).pack(side=tk.RIGHT)

        # --- Zone list ---
        zones_lf = ttk.LabelFrame(main, text="  Monitored Zones  ", padding=4)
        zones_lf.pack(fill=tk.BOTH, expand=True, padx=12, pady=(0, 6))

        self._canvas_scroll = tk.Canvas(zones_lf, bg=BG, highlightthickness=0)
        scrollbar = ttk.Scrollbar(
            zones_lf, orient=tk.VERTICAL, command=self._canvas_scroll.yview
        )
        self._zone_frame = ttk.Frame(self._canvas_scroll)

        self._zone_frame.bind(
            "<Configure>",
            lambda e: self._canvas_scroll.configure(
                scrollregion=self._canvas_scroll.bbox("all")
            ),
        )
        self._canvas_scroll.create_window((0, 0), window=self._zone_frame, anchor=tk.NW)
        self._canvas_scroll.configure(yscrollcommand=scrollbar.set)

        self._canvas_scroll.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        self._empty_label = ttk.Label(
            self._zone_frame,
            text="No zones selected.\nClick 'Select Zones' to begin.",
            style="Empty.TLabel",
            justify=tk.CENTER,
            padding=40,
        )
        self._empty_label.pack(fill=tk.X)

        # --- Status bar ---
        self._status_var = tk.StringVar(value="Ready")
        ttk.Label(
            self.root, textvariable=self._status_var, style="StatusBar.TLabel"
        ).pack(fill=tk.X, side=tk.BOTTOM)

    def _on_threshold_changed(self, _val: str) -> None:
        self._threshold_label.configure(text=f"{self._threshold_var.get() * 100:.1f}%")

    def _on_interval_changed(self, _val: str) -> None:
        v = int(float(self._interval_var.get()))
        self._interval_var.set(v)
        self._interval_label.configure(text=f"{v}ms")

    # --- Zone preview ---

    def _toggle_preview(self) -> None:
        if self._preview_window and self._preview_window.winfo_exists():
            self._hide_preview()
        else:
            self._show_preview()

    def _show_preview(self) -> None:
        if not self.zones:
            self._status_var.set("No zones to preview")
            return

        self.root.withdraw()
        self.root.update_idletasks()
        time.sleep(0.3)

        screenshot = self._capturer.grab_fullscreen()
        self.root.deiconify()

        screen_w = screenshot.width
        screen_h = screenshot.height

        self._preview_window = tk.Toplevel(self.root)
        self._preview_window.overrideredirect(True)
        self._preview_window.attributes("-topmost", True)
        self._preview_window.geometry(f"{screen_w}x{screen_h}+0+0")

        canvas = tk.Canvas(
            self._preview_window, width=screen_w, height=screen_h,
            highlightthickness=0, cursor="hand2",
        )
        canvas.pack(fill=tk.BOTH, expand=True)

        self._preview_photo = pil_to_tk(screenshot)
        canvas.create_image(0, 0, anchor=tk.NW, image=self._preview_photo)

        for i, zone in enumerate(self.zones):
            left, top, right, bottom = zone.bbox
            canvas.create_rectangle(
                left, top, right, bottom,
                outline=SELECTION_COLOR, width=3,
            )
            canvas.create_text(
                left + 5, top + 5, text=zone.name,
                anchor=tk.NW, fill=SELECTION_COLOR,
                font=(FONT, 12, "bold"),
            )

        # Dismiss on click or Escape
        canvas.bind("<Button-1>", lambda e: self._hide_preview())
        self._preview_window.bind("<Escape>", lambda e: self._hide_preview())
        self._preview_window.focus_force()

        self._preview_btn.configure(text="Hide Zones", style="Active.TButton")

    def _hide_preview(self) -> None:
        if self._preview_window and self._preview_window.winfo_exists():
            self._preview_window.destroy()
        self._preview_window = None
        self._preview_photo = None
        self._preview_btn.configure(text="Show Zones", style="TButton")

    def _select_zones(self) -> None:
        if self.is_monitoring:
            self._stop_monitoring()
        self._hide_preview()
        ZoneSelector(self.root, self._capturer, self._on_zones_selected)

    def _on_zones_selected(
        self, zones: list[ZoneConfig], screenshot: Image.Image | None
    ) -> None:
        if not zones:
            return

        self._clear_zones()
        self.zones = zones
        self.states = [ZoneState() for _ in zones]
        self._empty_label.pack_forget()

        for i, zone in enumerate(zones):
            widget = ZoneMonitorWidget(
                self._zone_frame,
                zone,
                zone_index=i,
                on_remove=lambda idx=i: self._remove_zone(idx),
            )
            widget.pack(fill=tk.X, padx=4, pady=4)
            self.widgets.append(widget)

            if screenshot is not None:
                crop = screenshot.crop(zone.bbox)
                self.states[i].prev_image = crop
                widget.update_display(self.states[i], crop)

        self._status_var.set(f"{len(zones)} zone(s) selected")

    def _clear_zones(self) -> None:
        for w in self.widgets:
            w.destroy()
        self.widgets.clear()
        self.zones.clear()
        self.states.clear()

    def _remove_zone(self, idx: int) -> None:
        if 0 <= idx < len(self.zones):
            self.widgets[idx].destroy()
            del self.zones[idx]
            del self.states[idx]
            del self.widgets[idx]

        if not self.zones:
            self._empty_label.pack(fill=tk.X)
            if self.is_monitoring:
                self._stop_monitoring()

        self._status_var.set(f"{len(self.zones)} zone(s)")

    def _toggle_monitoring(self) -> None:
        if self.is_monitoring:
            self._stop_monitoring()
        else:
            self._start_monitoring()

    def _start_monitoring(self) -> None:
        if not self.zones:
            self._status_var.set("No zones to monitor")
            return

        self.is_monitoring = True
        self._monitor_btn.configure(text="Stop (F12)", style="Active.TButton")
        self._select_btn.configure(state=tk.DISABLED)
        self._status_var.set("Monitoring...")
        self._monitor_cycle()

    def _stop_monitoring(self) -> None:
        self.is_monitoring = False
        if self._after_id is not None:
            self.root.after_cancel(self._after_id)
            self._after_id = None
        for state in self.states:
            state.reset()
        self._monitor_btn.configure(text="Start (F11)", style="TButton")
        self._select_btn.configure(state=tk.NORMAL)
        self._status_var.set("Monitoring stopped")

    def _monitor_cycle(self) -> None:
        if not self.is_monitoring:
            return

        threshold = self._threshold_var.get()
        consec_required = self._consec_var.get()

        results = self._monitor.check_zones(
            self.zones, self.states, threshold, consec_required
        )

        any_frozen = any(self.states[i].is_frozen for i, _ in results)

        for i, new_img in results:
            if i < len(self.widgets):
                self.widgets[i].update_display(self.states[i], new_img)

        ts = time.strftime("%H:%M:%S")
        frozen_text = "  |  FROZEN DETECTED" if any_frozen else ""
        self._status_var.set(
            f"Monitoring {len(self.zones)} zone(s)  |  Last check: {ts}{frozen_text}"
        )

        self._after_id = self.root.after(self._interval_var.get(), self._monitor_cycle)

    def _on_close(self) -> None:
        self._stop_monitoring()
        self._hotkeys.stop()
        self._sound.cleanup()
        self.root.destroy()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    capturer = ScrotCapturer()
    comparator = RMSComparator()
    sound = AplaySound()
    monitor = FreezeMonitor(capturer, comparator, sound)

    root = tk.Tk()

    hotkeys = PynputHotkeys(
        on_start=lambda: root.after(0, app._start_monitoring),
        on_stop=lambda: root.after(0, app._stop_monitoring),
    )

    app = FreezeDetectorApp(root, capturer, sound, monitor, hotkeys)
    root.mainloop()


if __name__ == "__main__":
    main()
