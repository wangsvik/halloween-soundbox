#!/usr/bin/env bash
# Installerer Halloween Soundbox på Raspberry Pi OS (Bookworm eller nyere).
# Kjør fra denne mappen:  ./install.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
USER_NAME="${SUDO_USER:-$USER}"

echo "==> Installerer systempakker"
sudo apt-get update
sudo apt-get install -y python3-venv python3-pip libsdl2-mixer-2.0-0 alsa-utils ffmpeg

echo "==> Lager Python-miljø"
python3 -m venv "$DIR/.venv"
"$DIR/.venv/bin/pip" install --upgrade pip
"$DIR/.venv/bin/pip" install -r "$DIR/requirements.txt"

echo "==> Gir $USER_NAME tilgang til lydkortet"
sudo usermod -aG audio "$USER_NAME"

echo "==> Installerer systemd-tjeneste"
sed -e "s|__DIR__|$DIR|g" -e "s|__USER__|$USER_NAME|g" "$DIR/soundbox.service" \
  | sudo tee /etc/systemd/system/soundbox.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable soundbox.service
sudo systemctl restart soundbox.service

IP="$(hostname -I | awk '{print $1}')"
echo
echo "Ferdig! Åpne http://$IP:8080 på telefonen."
echo "Logg:   journalctl -u soundbox -f"
