#!/usr/bin/env bash
# Starts an image the way the README recommends hardening it (read-only, no capabilities, fresh
# named volumes) and checks it turns healthy and serves the interface.
set -euo pipefail
image=$1
name=vixion-smoke-$$
cleanup() {
  [ "$1" -eq 0 ] || docker logs "$name" 2>&1 | tail -20
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap 'cleanup $?' EXIT
docker run -d --name "$name" --read-only --cap-drop ALL --security-opt no-new-privileges \
  --health-interval 1s --mount type=volume,dst=/config --mount type=volume,dst=/recordings \
  -e VIXION_TWITCH_TOKEN=smoketest0000000000000000000000 \
  -p 127.0.0.1:18080:6280 "$image" >/dev/null
for _ in $(seq 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || { echo "the container stopped"; exit 1; }
  sleep 1
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy ] || { echo "never healthy"; exit 1; }
curl -fsS http://127.0.0.1:18080/ | grep -q '<div id="root">' || { echo "no interface"; exit 1; }
curl -fsS http://127.0.0.1:18080/api/health >/dev/null
echo "$image: healthy, $(docker stats --no-stream --format '{{.MemUsage}}' "$name")"
