# 🎃 Halloween Soundbox

En Raspberry Pi-lydboks du styrer fra **telefonen** og fra **Homey Pro** (med egne flow-kort).

```
Telefon (nettleser / app på hjemskjermen) ──┐
                                            ▼
                     Raspberry Pi  –  pi/server.py  (port 8080)
                       • effekter (flere samtidig) + ambiens i loop
                       • ambiensen dempes automatisk når en effekt spiller
                       • annonserer seg på nettverket (mDNS)
                                            ▲
Homey Pro  –  homey-app/  ──────────────────┘  (sanntid via WebSocket)
```

## Handleliste

| Del | Forslag |
|---|---|
| Raspberry Pi | Pi 4, Pi 3B+ eller Pi Zero 2 W (alle fungerer) |
| Lyd ut | Aktiv høyttaler i 3,5 mm-jacken (Pi 3/4), **eller** USB-lydkort, **eller** forsterker-HAT (f.eks. HiFiBerry MiniAmp / Adafruit Speaker Bonnet) + passive høyttalere |
| Strøm | Offisiell strømforsyning. Utendørs: skjul boksen i en tett kasse eller under et tak |
| SD-kort | 16 GB+ med Raspberry Pi OS Lite (Bookworm eller nyere) |

> Tips: Pi Zero 2 W har ingen lydjack, så bruk USB-lydkort eller en HAT.

## 1. Sett opp Pi-en

1. Flash **Raspberry Pi OS Lite** med Raspberry Pi Imager. Sett vertsnavn (f.eks. `soundbox`), WiFi og aktiver SSH i Imager-innstillingene.
2. Kopier `pi/`-mappen til Pi-en:
   ```bash
   scp -r pi/ pi@soundbox.local:~/soundbox
   ```
3. Installer (lager venv, installerer avhengigheter og starter tjenesten automatisk ved oppstart):
   ```bash
   ssh pi@soundbox.local
   cd ~/soundbox && ./install.sh
   ```
4. Velg lydutgang om nødvendig: `sudo raspi-config` → *System Options* → *Audio*. Test med `speaker-test -t wav -c 2`.
5. Åpne **http://soundbox.local:8080** (eller `http://<ip>:8080`) på telefonen.
   - iPhone: Del → *Legg til på Hjem-skjerm*. Android: ⋮ → *Legg til på startskjermen*. Da oppfører den seg som en app.

Logg: `journalctl -u soundbox -f` · Omstart: `sudo systemctl restart soundbox`

## 2. Legg inn lydene dine

```
pi/sounds/
├── effects/
│   ├── skrik/          ← mappenavnet blir kategorien
│   │   ├── heks-latter.mp3
│   │   └── 01-blodig-skrik.mp3   (tall foran = sortering, vises ikke)
│   ├── monstre/
│   │   └── varulv.mp3
│   └── dorklokke.mp3   ← filer rett i effects/ havner i «Diverse»
└── ambient/
    ├── storm.mp3       ← spilles i loop
    └── hjemsøkt-hus.mp3
```

- Formater: **MP3, WAV, OGG**. Nye filer plukkes opp automatisk (ingen omstart).
- Kopier med `scp`, eller del mappen via Samba om du vil dra og slippe fra PC-en.
- `effects/demo/` og `ambient/vind.wav` er syntetiske testlyder. Slett dem når du har lagt inn egne.
- Gratis lyder: freesound.org, pixabay.com/sound-effects (sjekk lisensen).

## 3. Installer Homey-appen

Fra PC/Mac med Node.js:

```bash
npm install -g homey
homey login
cd homey-app
npm install
homey app install      # installerer permanent på din Homey Pro
```

Så i Homey-appen: **Enheter → + → Halloween Soundbox**. La IP-feltet stå tomt for automatisk søk. Finnes ikke boksen, skriv inn IP-en til Pi-en. Boksen finnes igjen automatisk om IP-en endrer seg.

### Hva du får i Homey

**Enhet:** av/på-flisen styrer ambiensen, i tillegg til volum, «Effekt spiller» og «Spiller nå».

| Type | Kort |
|---|---|
| **Når …** | En lyd startet *(tokens: lyd, lyd-ID, kategori, varighet)* · En lyd ble ferdig *(+ avbrutt)* · **[lyd] er ferdig** |
| **Og …** | En lyd spiller / spiller ikke · Ambiens er / er ikke på |
| **Så …** | Spill [lyd] · Spill [lyd] med [volum] % · **Spill [lyd] og vent til den er ferdig** · Spill tilfeldig lyd fra [kategori] · Start ambiens [spor] · Stopp ambiens · Stopp alle lyder · *(innebygd)* Sett volum |

Lydlistene i kortene hentes live fra Pi-en, så nye filer dukker opp med en gang.

### Spille lydene på Sonos (eller Chromecast)

Pi-en deler alle lydfilene som lenker, og tre kort i Homey **gir deg lenken uten å spille noe på Pi-en**:

| Kort | Tokens |
|---|---|
| Finn URL for [lyd] | URL, Lyd, Kategori |
| Finn tilfeldig lyd-URL fra [kategori] | URL, Lyd, Kategori |
| Finn URL for ambiens [spor] | URL, Ambiens |

Koble URL-tokenet til Sonos-kortet **«Spill URL [url] på volum [volum]»**. Det spiller lyden *oppå* det som står på: musikken dempes og fortsetter av seg selv etterpå.

```
Når  bevegelse ute
Så   Soundbox: Finn tilfeldig lyd-URL fra «Skrik»
     Stue (Sonos): Spill URL [URL] på volum 60
```

Samme URL fungerer i Chromecast-kortet «Cast audio URL».

**Viktig:**
- Gi Pi-en **fast IP** (DHCP-reservasjon i UniFi), ellers slutter lenkene å virke når IP-en endres.
- Bruk helst **MP3** til lyder som skal til Sonos.
- Når lyden spilles på Sonos, utløses *ikke* «En lyd startet/ble ferdig» i soundboxen. De kortene gjelder bare avspilling på Pi-en.
- Ambiens i loop bør bli på Pi-ens høyttaler. Sonos-kortet «Spill av URL» erstatter musikken, og lydklipp går ikke i loop.

### Eksempel-Flows

1. **Skrekk-dørklokke:** *Når* dørklokken ringer → *Så* Spill tilfeldig lyd fra «Skrik» + blink utelyset rødt.
2. **Bevegelse i innkjørselen:** *Når* bevegelsessensoren ute oppdager bevegelse → *Og* en lyd spiller **ikke** → *Så* Spill tilfeldig lyd. (Hindrer at lydene stables.)
3. **Stemning hele kvelden:** *Når* solen går ned 31. oktober → *Så* Start ambiens «Storm» med volum 40 %. *Når* klokken er 22:00 → Stopp alle lyder.
4. **Advanced Flow – regissert skrekk-sekvens:** Bevegelse → slå av lys → **Spill «Dørknirk» og vent til den er ferdig** → vent 1 s → Spill «Skrik» med 100 % + lys blinker → *Når «Skrik» er ferdig* → lys på igjen.

## Konfigurasjon (`pi/config.yaml`)

| Nøkkel | Standard | Forklaring |
|---|---|---|
| `name` | Halloween Soundbox | Navnet Homey ser |
| `port` | 8080 | |
| `api_key` | *(tom)* | Sett en nøkkel om nettet ikke bare er ditt. Oppgis da ved paring i Homey og én gang i mobilappen |
| `channels` | 8 | Antall effekter som kan spille samtidig |
| `duck_level` | 0.35 | Ambiensens volum mens en effekt spiller |
| `ambient_level` | 0.6 | Ambiensens volum i forhold til hovedvolumet |
| `resume_ambient` | true | Starter ambiensen igjen etter strømbrudd |

## HTTP-API (for andre integrasjoner)

| Metode | Sti | Body |
|---|---|---|
| GET | `/api/sounds` | |
| GET | `/api/state` | |
| POST | `/api/play` | `{"id": "skrik/heks-latter", "volume": 80}` |
| POST | `/api/play/random` | `{"category": "skrik"}` (valgfri) |
| POST | `/api/ambient` | `{"on": true, "id": "storm"}` |
| POST | `/api/volume` | `{"level": 60}` |
| POST | `/api/stop` | `{"what": "all" \| "effects" \| "ambient"}` |
| GET | `/media/effects/<id>.mp3` · `/media/ambient/<id>.mp3` | selve lydfilen (for Sonos o.l.). Stien står i feltet `media` i `/api/sounds` |
| WS | `/ws` | sender `state`, `sound_started`, `sound_finished` |

Med API-nøkkel: header `X-Api-Key: <nøkkel>` (eller `?key=` i URL-en). Interaktiv dokumentasjon finnes på `http://<pi>:8080/docs`.

## Feilsøking

- **Ingen lyd:** `speaker-test -c 2`, sjekk lydutgang i `raspi-config`, og at volumet ikke står på 0 i `alsamixer`.
- **Homey finner ikke boksen:** Pi-en og Homey må være på samme nett/VLAN (mDNS går ikke over rutere og gjestenett). Skriv inn IP-en manuelt ved paring.
- **Enheten er «utilgjengelig» i Homey:** Pi-en er av eller har ny IP. Appen kobler seg til igjen automatisk. Ellers kan du rette IP-en under enhetens innstillinger.
- **Test Homey-appen mot Pi-en uten Homey:** `cd homey-app && SOUNDBOX_ADDRESS=<pi-ip> npm test`

## Utvikling lokalt (uten Pi)

```bash
cd pi
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
SDL_AUDIODRIVER=dummy .venv/bin/python server.py   # dummy = ingen lydkort nødvendig
```
