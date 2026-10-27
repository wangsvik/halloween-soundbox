"""Lydmotor basert på pygame.mixer.

- Effekter spilles på egne kanaler og kan overlappe hverandre.
- Ambiens strømmes via pygame.mixer.music (lite minnebruk, også på Pi Zero) i loop.
- Ambiensen dempes ("ducking") mens en effekt spiller, og glir tilbake etterpå.
- En overvåkingstråd oppdager når effekter er ferdige og sender hendelser.
"""

from __future__ import annotations

import itertools
import logging
import os
import threading
import time
from collections import OrderedDict
from typing import Callable

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
import pygame  # noqa: E402

from library import Sound  # noqa: E402

log = logging.getLogger("soundbox.audio")

EventCallback = Callable[[dict], None]


class AudioEngine:
    FADE_MS = 1500
    TICK = 0.05
    CACHE_SIZE = 64

    def __init__(self, on_event: EventCallback, channels: int = 8,
                 duck_level: float = 0.35, ambient_level: float = 0.6):
        pygame.mixer.pre_init(44100, -16, 2, 1024)
        pygame.mixer.init()
        pygame.mixer.set_num_channels(channels)

        self._on_event = on_event
        self._lock = threading.RLock()
        self._cache: OrderedDict[str, tuple[float, pygame.mixer.Sound]] = OrderedDict()
        self._active: dict[int, dict] = {}
        self._play_ids = itertools.count(1)
        self._ambient_gain = 0.0

        self.duck_level = duck_level
        self.ambient_level = ambient_level
        self.volume = 70  # 0–100, hovedvolum
        self.ambient: Sound | None = None

        self._running = True
        self._thread = threading.Thread(target=self._monitor, name="audio-monitor", daemon=True)
        self._thread.start()

    # ---------- lasting ----------

    def _load(self, sound: Sound) -> pygame.mixer.Sound:
        key = str(sound.path)
        mtime = sound.path.stat().st_mtime
        cached = self._cache.get(key)
        if cached and cached[0] == mtime:
            self._cache.move_to_end(key)
            return cached[1]
        snd = pygame.mixer.Sound(key)
        self._cache[key] = (mtime, snd)
        while len(self._cache) > self.CACHE_SIZE:
            self._cache.popitem(last=False)
        return snd

    def preload(self, sounds: list[Sound]) -> None:
        for sound in sounds:
            try:
                with self._lock:
                    self._load(sound)
            except Exception as exc:  # ødelagt fil skal ikke stoppe oppstart
                log.warning("Kunne ikke laste %s: %s", sound.path, exc)

    # ---------- effekter ----------

    def play(self, sound: Sound, gain: float = 1.0) -> dict:
        with self._lock:
            snd = self._load(sound)
            channel = pygame.mixer.find_channel(force=True)
            # Kanalen kan ha blitt stjålet fra en eldre effekt
            for pid, entry in list(self._active.items()):
                if entry["channel"] is channel:
                    self._finish(pid, interrupted=True)
            gain = max(0.0, min(1.0, gain))
            channel.set_volume(self.volume / 100 * gain)
            channel.play(snd)
            play_id = next(self._play_ids)
            entry = {
                "play_id": play_id,
                "channel": channel,
                "snd": snd,
                "sound": sound,
                "gain": gain,
                "duration": round(snd.get_length(), 2),
                "started": time.time(),
            }
            self._active[play_id] = entry
        event = {"type": "sound_started", **self._describe(entry)}
        self._emit(event)
        self._emit_state()
        return event

    def stop_effects(self) -> None:
        with self._lock:
            for pid in list(self._active):
                self._active[pid]["channel"].stop()
                self._finish(pid, interrupted=True)
        self._emit_state()

    def _finish(self, play_id: int, interrupted: bool) -> None:
        entry = self._active.pop(play_id, None)
        if entry:
            self._emit({"type": "sound_finished", "interrupted": interrupted, **self._describe(entry)})

    @staticmethod
    def _describe(entry: dict) -> dict:
        return {
            "play_id": entry["play_id"],
            "sound": entry["sound"].public(),
            "duration": entry["duration"],
        }

    # ---------- ambiens ----------

    def start_ambient(self, sound: Sound) -> None:
        with self._lock:
            pygame.mixer.music.stop()
            pygame.mixer.music.load(str(sound.path))
            self._ambient_gain = self._ambient_target()
            pygame.mixer.music.set_volume(self._ambient_gain)
            pygame.mixer.music.play(loops=-1, fade_ms=self.FADE_MS)
            self.ambient = sound
        self._emit_state()

    def stop_ambient(self) -> None:
        with self._lock:
            if self.ambient is None:
                return
            pygame.mixer.music.fadeout(self.FADE_MS)
            self.ambient = None
        self._emit_state()

    def _ambient_target(self) -> float:
        target = self.volume / 100 * self.ambient_level
        if self._active:
            target *= self.duck_level
        return target

    # ---------- felles ----------

    def set_volume(self, level: int) -> None:
        with self._lock:
            self.volume = max(0, min(100, int(level)))
            for entry in self._active.values():
                entry["channel"].set_volume(self.volume / 100 * entry["gain"])
        self._emit_state()

    def stop_all(self) -> None:
        self.stop_effects()
        self.stop_ambient()

    def state(self) -> dict:
        with self._lock:
            current = max(self._active.values(), key=lambda e: e["started"], default=None)
            return {
                "volume": self.volume,
                "playing": bool(self._active),
                "current": self._describe(current) if current else None,
                "active": [self._describe(e) for e in self._active.values()],
                "ambient": self.ambient.public() if self.ambient else None,
            }

    def _emit(self, event: dict) -> None:
        try:
            self._on_event(event)
        except Exception:
            log.exception("Feil i hendelsesmottaker")

    def _emit_state(self) -> None:
        self._emit({"type": "state", **self.state()})

    def _monitor(self) -> None:
        while self._running:
            changed = False
            with self._lock:
                for pid, entry in list(self._active.items()):
                    ch = entry["channel"]
                    if not ch.get_busy() or ch.get_sound() is not entry["snd"]:
                        self._finish(pid, interrupted=False)
                        changed = True
                # Myk ducking av ambiensen
                if self.ambient is not None:
                    target = self._ambient_target()
                    step = 0.04
                    if abs(self._ambient_gain - target) > 0.005:
                        self._ambient_gain += max(-step, min(step, target - self._ambient_gain))
                        pygame.mixer.music.set_volume(self._ambient_gain)
            if changed:
                self._emit_state()
            time.sleep(self.TICK)

    def close(self) -> None:
        self._running = False
        self._thread.join(timeout=1)
        pygame.mixer.quit()
