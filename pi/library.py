"""Finner lydfiler på disk og gir dem stabile id-er, navn og kategorier.

Mappestruktur:
    sounds/effects/<kategori>/<fil>.mp3   -> effekt, id "<kategori>/<fil>"
    sounds/effects/<fil>.mp3              -> effekt i kategorien "diverse"
    sounds/ambient/<fil>.mp3              -> bakgrunnsambiens (spilles i loop)
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, asdict
from pathlib import Path

AUDIO_EXTENSIONS = {".mp3", ".wav", ".ogg"}
DEFAULT_CATEGORY = "diverse"
RESCAN_INTERVAL = 2.0  # sekunder; nye filer plukkes opp uten restart


@dataclass(frozen=True)
class Sound:
    id: str
    name: str
    category: str
    kind: str  # "effect" | "ambient"
    path: Path

    def public(self) -> dict:
        data = asdict(self)
        del data["path"]
        data["media"] = self.media_path
        return data

    @property
    def media_path(self) -> str:
        """Sti under /media som Sonos/Chromecast kan hente filen fra."""
        folder = "effects" if self.kind == "effect" else "ambient"
        return f"/media/{folder}/{self.id}{self.path.suffix.lower()}"


def _slug(text: str) -> str:
    text = text.lower().replace("æ", "ae").replace("ø", "o").replace("å", "a")
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-") or "lyd"


def _pretty(text: str) -> str:
    text = re.sub(r"^\d+[\s._-]*", "", text)  # "01-skrik" -> "skrik", for sortering på disk
    text = re.sub(r"[_-]+", " ", text).strip() or "Lyd"
    return text[0].upper() + text[1:]


class SoundLibrary:
    def __init__(self, root: Path):
        self.root = Path(root)
        self._lock = threading.Lock()
        self._sounds: dict[str, Sound] = {}
        self._ambient: dict[str, Sound] = {}
        self._scanned_at = 0.0
        (self.root / "effects").mkdir(parents=True, exist_ok=True)
        (self.root / "ambient").mkdir(parents=True, exist_ok=True)

    def _scan(self) -> None:
        effects: dict[str, Sound] = {}
        for path in sorted((self.root / "effects").rglob("*")):
            if path.suffix.lower() not in AUDIO_EXTENSIONS or not path.is_file():
                continue
            rel = path.relative_to(self.root / "effects")
            folder = rel.parts[0] if len(rel.parts) > 1 else DEFAULT_CATEGORY
            sound_id = f"{_slug(folder)}/{_slug(path.stem)}"
            effects[sound_id] = Sound(sound_id, _pretty(path.stem), _slug(folder), "effect", path)

        ambient: dict[str, Sound] = {}
        for path in sorted((self.root / "ambient").rglob("*")):
            if path.suffix.lower() not in AUDIO_EXTENSIONS or not path.is_file():
                continue
            sound_id = _slug(path.stem)
            ambient[sound_id] = Sound(sound_id, _pretty(path.stem), "ambient", "ambient", path)

        self._sounds, self._ambient = effects, ambient
        self._scanned_at = time.monotonic()

    def _fresh(self) -> None:
        with self._lock:
            if time.monotonic() - self._scanned_at > RESCAN_INTERVAL:
                self._scan()

    def effects(self) -> list[Sound]:
        self._fresh()
        return list(self._sounds.values())

    def ambient(self) -> list[Sound]:
        self._fresh()
        return list(self._ambient.values())

    def categories(self) -> list[str]:
        return sorted({s.category for s in self.effects()})

    def effect(self, sound_id: str) -> Sound | None:
        self._fresh()
        return self._sounds.get(sound_id)

    def ambient_track(self, sound_id: str) -> Sound | None:
        self._fresh()
        return self._ambient.get(sound_id)
