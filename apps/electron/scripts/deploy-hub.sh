#!/usr/bin/env bash
#
# deploy-hub.sh — build the HiDock hosted-hub image on the Unraid server over SSH,
# then cut the running container over to it.
#
# WHY caffeinate: the build runs on the remote daemon via DOCKER_HOST=ssh, but the
# local `docker` CLI holds the SSH connection open for the whole build. If the Mac
# idle-sleeps mid-build the pipe drops; the remote daemon finishes and tags :latest,
# but the local CLI never gets the done-ack and hangs FOREVER (0 CPU, no output).
# Wrapping the long-running docker commands in `caffeinate -i -s` prevents idle/system
# (AC) sleep for their lifetime so this can't recur. (Lid-close on battery still sleeps —
# caffeinate can't stop that; keep the lid open or on AC for a build.)
#
# Usage (run from anywhere; build context is always apps/electron):
#   ./scripts/deploy-hub.sh                 # rollback-tag -> build -> cutover -> verify
#   SKIP_CUTOVER=1 ./scripts/deploy-hub.sh  # build the image only, don't recreate the container
#   npm run deploy:hub                      # same, via package.json
#
# Overridable via env: SSH_HOST SSH_PORT IMAGE COMPOSE_FILE PUBLIC_URL CONTAINER
#
set -euo pipefail

SSH_HOST="${SSH_HOST:-root@coxnas.tail211046.ts.net}"
SSH_PORT="${SSH_PORT:-2222}"
IMAGE="${IMAGE:-rogercoxjr/hidock-hub:latest}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.unraid.yml}"
PUBLIC_URL="${PUBLIC_URL:-https://hidock.coxserver.com}"
CONTAINER="${CONTAINER:-hidock-hub}"

export DOCKER_HOST="ssh://${SSH_HOST}:${SSH_PORT}"
export DOCKER_BUILDKIT=1

# ssh with keepalives so a stalled link fails fast instead of hanging (bash-3.2-safe string).
SSH_OPTS="-p ${SSH_PORT} -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3"

# caffeinate prefix (empty on non-macOS so the script still runs there).
CAFF="caffeinate -i -s"
command -v caffeinate >/dev/null 2>&1 || CAFF=""

# Always build from apps/electron regardless of caller cwd.
cd "$(cd "$(dirname "$0")" && pwd)/.."

echo "▶ Deploy → ${DOCKER_HOST}   image=${IMAGE}   context=$(pwd)"
[ -z "$CAFF" ] && echo "  ⚠ caffeinate not found — no sleep guard (non-macOS?)"

# 1) Roll-back tag: snapshot the current :latest before the build overwrites it.
CUR_ID="$(ssh $SSH_OPTS "$SSH_HOST" "docker image inspect --format '{{.Id}}' $IMAGE 2>/dev/null" 2>/dev/null | cut -c8-19 || true)"
if [ -n "$CUR_ID" ]; then
  ROLLBACK_TAG="${IMAGE%:*}:pre-deploy-${CUR_ID}"
  ssh $SSH_OPTS "$SSH_HOST" "docker tag $IMAGE $ROLLBACK_TAG" && echo "  rollback tag: ${ROLLBACK_TAG}"
else
  echo "  (no existing :latest to tag — first deploy?)"
fi

# 2) Build on the server, caffeinated so a sleeping Mac can't drop the SSH pipe mid-build.
echo "▶ Building (caffeinated)…"
$CAFF docker build -t "$IMAGE" .

if [ "${SKIP_CUTOVER:-0}" = "1" ]; then
  echo "▶ SKIP_CUTOVER=1 — image built + tagged ${IMAGE}; container NOT recreated."
  echo "  Cut over later:  DOCKER_HOST=${DOCKER_HOST} docker compose -f ${COMPOSE_FILE} up -d"
  exit 0
fi

# 3) Cut over (also caffeinated — quick, but harmless to guard).
echo "▶ Cutover…"
$CAFF docker compose -f "$COMPOSE_FILE" up -d

# 4) Verify container health, then the public path end-to-end.
echo "▶ Verifying container health…"
i=1
while [ "$i" -le 15 ]; do
  H="$(ssh $SSH_OPTS "$SSH_HOST" "docker inspect --format '{{.State.Health.Status}}' $CONTAINER 2>/dev/null" 2>/dev/null || true)"
  echo "  t=$((i*3))s health=${H:-unknown}"
  [ "$H" = "healthy" ] && break
  sleep 3
  i=$((i+1))
done

echo "▶ Public checks…"
curl -sS -o /dev/null -w "  root:    HTTP %{http_code}\n" "${PUBLIC_URL}/" --max-time 20 || true
curl -sS -o /dev/null -w "  healthz: HTTP %{http_code}\n" "${PUBLIC_URL}/healthz" --max-time 20 || true
BUNDLE="$(curl -sS "${PUBLIC_URL}/" --max-time 20 | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1 || true)"
echo "  serving bundle: ${BUNDLE:-<none>}"
NEW_ID="$(ssh $SSH_OPTS "$SSH_HOST" "docker inspect --format '{{.Image}}' $CONTAINER 2>/dev/null" 2>/dev/null | cut -c8-19 || true)"
echo "✔ Done. Live image: ${NEW_ID:-unknown}"
