#!/usr/bin/env bash
set -euo pipefail

sha=${1:?release SHA required}
checksum=${2:?archive SHA-256 required}
url=${3:?archive URL required}
[[ $sha =~ ^[0-9a-f]{40}$ && $checksum =~ ^[0-9a-f]{64}$ ]] || exit 1
[[ $url == "https://tigerapps-discord-bot-deploy-104733724423-us-east-1.s3.us-east-1.amazonaws.com/releases/$sha.tar.gz?X-Amz-"* ]] || exit 1

live=/opt/tigerapps-discord-bot
releases=/opt/tigerapps-discord-releases
previous=$(readlink -f "$live")
[[ $previous == "$releases/"* ]] || { echo 'Live bot path is not a versioned release.' >&2; exit 1; }
mkdir -p "$releases"
release="$releases/$sha"

if [[ ! -d $release ]]; then
  stage=$(mktemp -d "$releases/.incoming.XXXXXX")
  trap 'rm -r -- "$stage" 2>/dev/null || true' EXIT
  curl -fsSL --retry 2 --max-time 120 "$url" -o "$stage/archive.tar.gz"
  printf '%s  %s\n' "$checksum" "$stage/archive.tar.gz" | sha256sum -c -
  chown tigerapps-bot:tigerapps-bot "$stage" "$stage/archive.tar.gz"
  runuser -u tigerapps-bot -- tar -xzf "$stage/archive.tar.gz" -C "$stage"
  runuser -u tigerapps-bot -- npm ci --omit=dev --prefix "$stage"
  runuser -u tigerapps-bot -- npm test --prefix "$stage"
  rm "$stage/archive.tar.gz"
  chown -R root:root "$stage"
  chmod 755 "$stage"
  mv "$stage" "$release"
fi

switch_release() {
  local link="$releases/.link.$$"
  ln -s "$1" "$link"
  mv -Tf "$link" "$live"
}

healthy() {
  for _ in {1..20}; do
    if curl -fsS --max-time 2 http://127.0.0.1:3100/health >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

switch_release "$release"
if systemctl restart tigerapps-discord-bot.service && healthy; then
  echo "Deployed $sha"
else
  switch_release "$previous"
  systemctl restart tigerapps-discord-bot.service
  healthy || echo 'Rollback health check failed.' >&2
  echo "Rolled back $sha" >&2
  exit 1
fi

mapfile -t stale < <(find "$releases" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex "$releases/[0-9a-f]{40}" -printf '%T@ %p\n' | sort -rn | tail -n +6 | cut -d' ' -f2-)
for path in "${stale[@]}"; do
  if [[ $path != "$release" && $path != "$previous" && $path =~ ^/opt/tigerapps-discord-releases/[0-9a-f]{40}$ ]]; then
    rm -r -- "$path"
  fi
done
