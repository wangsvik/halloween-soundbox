"""Halloween Soundbox – HTTP/WebSocket-server for Raspberry Pi.

Start:  python server.py   (eller via systemd, se soundbox.service)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
import yaml
from fastapi import Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from audio import AudioEngine
from discovery import Announcer
from library import SoundLibrary

VERSION = "1.0.0"
BASE = Path(__file__).resolve().parent

log = logging.getLogger("soundbox")

DEFAULT_CONFIG = {
    "name": "Halloween Soundbox",
    "port": 8080,
    "api_key": "",           # tom = ingen nøkkel (greit på eget hjemmenett)
    "sounds_dir": "sounds",
    "channels": 8,           # hvor mange effekter som kan spille samtidig
    "duck_level": 0.35,      # ambiens-volum (andel) mens en effekt spiller
    "ambient_level": 0.6,    # ambiens-volum i forhold til hovedvolum
    "default_volume": 70,
    "resume_ambient": True,  # start ambiens igjen etter omstart
    "mdns": True,
}


def load_config() -> dict:
    path = Path(os.environ.get("SOUNDBOX_CONFIG", BASE / "config.yaml"))
    config = dict(DEFAULT_CONFIG)
    if path.exists():
        config.update(yaml.safe_load(path.read_text()) or {})
    return config


class Persisted:
    """Liten JSON-fil med volum, aktiv ambiens og en stabil enhets-id."""

    def __init__(self, path: Path):
        self.path = path
        try:
            self.data = json.loads(path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            self.data = {}
        if "device_id" not in self.data:
            self.data["device_id"] = uuid.uuid4().hex[:12]
            self.save()

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=2))
        tmp.replace(self.path)


class Hub:
    """Holder WebSocket-klienter og sender hendelser fra lydtråden til dem."""

    def __init__(self):
        self.clients: set[WebSocket] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    def publish(self, event: dict) -> None:  # trådsikker
        if self.loop and not self.loop.is_closed():
            asyncio.run_coroutine_threadsafe(self._broadcast(event), self.loop)

    async def _broadcast(self, event: dict) -> None:
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(event)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


config = load_config()
hub = Hub()
persisted = Persisted(BASE / "state.json")
library = SoundLibrary(BASE / config["sounds_dir"])
engine: AudioEngine | None = None
announcer: Announcer | None = None


def on_audio_event(event: dict) -> None:
    if event["type"] == "state" and engine is not None:
        ambient = event.get("ambient")
        changed = (persisted.data.get("volume") != event["volume"]
                   or persisted.data.get("ambient") != (ambient and ambient["id"]))
        if changed:
            persisted.data["volume"] = event["volume"]
            persisted.data["ambient"] = ambient and ambient["id"]
            persisted.save()
    hub.publish(event)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global engine, announcer
    hub.loop = asyncio.get_running_loop()
    engine = AudioEngine(on_audio_event, channels=config["channels"],
                         duck_level=config["duck_level"], ambient_level=config["ambient_level"])
    engine.set_volume(persisted.data.get("volume", config["default_volume"]))
    asyncio.get_running_loop().run_in_executor(None, engine.preload, library.effects())

    if config["resume_ambient"] and persisted.data.get("ambient"):
        track = library.ambient_track(persisted.data["ambient"])
        if track:
            engine.start_ambient(track)

    if config["mdns"]:
        announcer = Announcer(persisted.data["device_id"], config["name"], config["port"], VERSION)
        try:
            await announcer.start()
        except Exception:
            log.exception("mDNS-annonsering feilet (Homey kan fortsatt legges til med IP)")
    yield
    if announcer:
        await announcer.stop()
    engine.close()


app = FastAPI(title="Halloween Soundbox", version=VERSION, lifespan=lifespan)


def require_key(x_api_key: str | None = Header(default=None), key: str | None = Query(default=None)):
    expected = config["api_key"]
    if expected and expected not in (x_api_key, key):
        raise HTTPException(401, "Feil eller manglende API-nøkkel")


auth = [Depends(require_key)]


class PlayRequest(BaseModel):
    id: str
    volume: int | None = Field(default=None, ge=0, le=100, description="Volum for denne avspillingen, 0–100 % av hovedvolum")


class RandomRequest(BaseModel):
    category: str | None = None
    volume: int | None = Field(default=None, ge=0, le=100)


class AmbientRequest(BaseModel):
    on: bool = True
    id: str | None = None


class VolumeRequest(BaseModel):
    level: int = Field(ge=0, le=100)


class StopRequest(BaseModel):
    what: str = Field(default="all", pattern="^(all|effects|ambient)$")


@app.get("/api/info")
def info():
    return {"name": config["name"], "id": persisted.data["device_id"], "version": VERSION,
            "auth": bool(config["api_key"])}


@app.get("/api/sounds", dependencies=auth)
def sounds():
    return {
        "effects": [s.public() for s in library.effects()],
        "ambient": [s.public() for s in library.ambient()],
        "categories": library.categories(),
    }


@app.get("/api/state", dependencies=auth)
def state():
    return engine.state()


def _gain(volume: int | None) -> float:
    return 1.0 if volume is None else volume / 100


@app.post("/api/play", dependencies=auth)
def play(req: PlayRequest):
    sound = library.effect(req.id)
    if not sound:
        raise HTTPException(404, f"Fant ikke lyden '{req.id}'")
    return engine.play(sound, _gain(req.volume))


@app.post("/api/play/random", dependencies=auth)
def play_random(req: RandomRequest | None = None):
    req = req or RandomRequest()
    pool = library.effects()
    if req.category:
        pool = [s for s in pool if s.category == req.category]
    if not pool:
        raise HTTPException(404, "Ingen lyder å velge mellom")
    current = engine.state()["current"]
    if len(pool) > 1 and current:  # unngå samme lyd to ganger på rad
        pool = [s for s in pool if s.id != current["sound"]["id"]] or pool
    return engine.play(random.choice(pool), _gain(req.volume))


@app.post("/api/ambient", dependencies=auth)
def ambient(req: AmbientRequest):
    if not req.on:
        engine.stop_ambient()
        return engine.state()
    tracks = library.ambient()
    if req.id:
        track = library.ambient_track(req.id)
        if not track:
            raise HTTPException(404, f"Fant ikke ambiens '{req.id}'")
    elif engine.ambient:
        return engine.state()
    elif tracks:
        last = persisted.data.get("last_ambient")
        track = library.ambient_track(last) if last else None
        track = track or tracks[0]
    else:
        raise HTTPException(404, "Ingen ambiens-filer i sounds/ambient")
    persisted.data["last_ambient"] = track.id
    engine.start_ambient(track)
    return engine.state()


@app.post("/api/volume", dependencies=auth)
def volume(req: VolumeRequest):
    engine.set_volume(req.level)
    return engine.state()


@app.post("/api/stop", dependencies=auth)
def stop(req: StopRequest | None = None):
    what = (req or StopRequest()).what
    if what in ("all", "effects"):
        engine.stop_effects()
    if what in ("all", "ambient"):
        engine.stop_ambient()
    return engine.state()


MEDIA_TYPES = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg"}


@app.get("/media/{kind}/{name:path}", dependencies=auth)
def media(kind: str, name: str):
    """Lydfilen selv, slik at Sonos/Chromecast kan strømme den fra Pi-en.

    /media/effects/skrik/heks-latter.mp3  ·  /media/ambient/storm.mp3
    (Filendelsen i URL-en er bare for spillere som vil se den; id-en avgjør.)
    """
    sound_id = name.rsplit(".", 1)[0] if "." in name.rsplit("/", 1)[-1] else name
    if kind == "effects":
        sound = library.effect(sound_id)
    elif kind == "ambient":
        sound = library.ambient_track(sound_id)
    else:
        sound = None
    if not sound:
        raise HTTPException(404, f"Fant ikke '{name}'")
    return FileResponse(sound.path, media_type=MEDIA_TYPES.get(sound.path.suffix.lower(), "application/octet-stream"))


@app.websocket("/ws")
async def websocket(ws: WebSocket, key: str | None = None):
    if config["api_key"] and key != config["api_key"]:
        await ws.close(code=4401)
        return
    await ws.accept()
    hub.clients.add(ws)
    try:
        await ws.send_json({"type": "state", **engine.state()})
        while True:
            message = await ws.receive_text()
            if message == "ping":
                await ws.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)


app.mount("/", StaticFiles(directory=BASE / "static", html=True), name="static")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    uvicorn.run(app, host="0.0.0.0", port=int(config["port"]))
