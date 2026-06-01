#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

$SUDO apt-get update
$SUDO apt-get install -y ca-certificates curl gnupg lsb-release rsync

$SUDO install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | $SUDO gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
$SUDO chmod a+r /etc/apt/keyrings/docker.gpg

. /etc/os-release
ARCH="$(dpkg --print-architecture)"
echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null

$SUDO apt-get update
$SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

$SUDO systemctl enable --now docker

if [[ -n "${SUDO_USER:-}" ]]; then
  $SUDO usermod -aG docker "$SUDO_USER"
  echo "Docker Engine installed. Log out and back in, or run 'newgrp docker', before using docker without sudo."
else
  echo "Docker Engine installed."
fi

docker --version
docker compose version
