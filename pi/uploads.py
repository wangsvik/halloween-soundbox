"""Lagring av opplastede lydfiler (fra nettsiden).

- MP3/WAV/OGG lagres som de er.
- Andre formater fra mobil/PC (M4A, AAC, FLAC, …) konverteres til MP3 med ffmpeg.
- Med normalize=True jevnes lydstyrken ut (EBU R128), så alle effekter er omtrent like høye.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

NATIVE = {".mp3", ".wav", ".ogg"}
CONVERTIBLE = {".m4a", ".aac", ".flac", ".opus", ".webm", ".mp4", ".wma", ".aif", ".aiff", ".3gp", ".amr", ".caf"}
MAX_BYTES = 50 * 1024 * 1024


class UploadError(ValueError):
    pass


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def accepted_extensions() -> list[str]:
    return sorted(NATIVE | (CONVERTIBLE if ffmpeg_available() else set()))


def clean_name(text: str, fallback: str = "lyd") -> str:
    """Trygt fil-/mappenavn som beholder æøå og mellomrom."""
    text = re.sub(r"[^\wæøåÆØÅ \-]+", "", text, flags=re.UNICODE).strip(" .-_")
    return re.sub(r"\s+", " ", text)[:60] or fallback


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    for n in range(2, 1000):
        candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
        if not candidate.exists():
            return candidate
    raise UploadError("For mange filer med samme navn")


def _ffmpeg_to_mp3(src: Path, dest: Path, normalize: bool) -> None:
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-vn",
           "-ac", "2", "-ar", "44100", "-codec:a", "libmp3lame", "-q:a", "2"]
    if normalize:
        cmd += ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"]
    cmd.append(str(dest))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        dest.unlink(missing_ok=True)
        raise UploadError("Kunne ikke lese lydfilen. Er den ødelagt, eller ikke en lydfil?")


def store(tmp: Path, original_name: str, folder: Path, normalize: bool) -> Path:
    """Flytter/konverterer en midlertidig fil inn i lydmappen. Returnerer endelig sti."""
    ext = Path(original_name).suffix.lower()
    stem = clean_name(Path(original_name).stem)
    folder.mkdir(parents=True, exist_ok=True)

    if ffmpeg_available() and (ext in CONVERTIBLE or (normalize and ext in NATIVE)):
        dest = _unique(folder / f"{stem}.mp3")
        _ffmpeg_to_mp3(tmp, dest, normalize)
        return dest
    if ext in NATIVE:
        dest = _unique(folder / f"{stem}{ext}")
        shutil.move(str(tmp), dest)
        return dest
    if ext in CONVERTIBLE:
        raise UploadError(f"{ext} krever ffmpeg på Pi-en (sudo apt install ffmpeg), eller last opp MP3/WAV")
    raise UploadError(f"Filtypen {ext or '(ingen)'} støttes ikke. Bruk MP3, WAV eller OGG")
