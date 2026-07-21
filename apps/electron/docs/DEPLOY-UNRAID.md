# Deploying the HiDock Hosted Hub on Unraid (behind nginxproxymanager)

This is the **operator runbook**. The image is the multi-stage build from
`apps/electron/Dockerfile`. The agent that wrote this cannot perform these steps
— they need the Unraid host, a domain, and a Google OAuth client.

Two ways to run it on Unraid, both produce the same running container:

- **Path A — Unraid "Add Container" template UI** (sections 1-3 below). No SSH
  needed. Config lives in Unraid's XML template store.
- **Path B — docker compose via SSH** (section 2b below). Requires SSH. Config
  lives in a `docker-compose.yml` + `.env` you version-control. Recommended if
  you want reproducible, portable deploys.

Section 4 (reverse proxy + OAuth) is identical for both paths.

## 1. Build & publish the image

On a build host (or Unraid with the Docker buildx plugin), from `apps/electron/`:

    DOCKER_BUILDKIT=1 docker build -t <registry>/hidock-hub:<tag> .
    docker push <registry>/hidock-hub:<tag>

(Or build locally on Unraid and reference the local image tag.)

> **Recommended: `npm run deploy:hub`** (`scripts/deploy-hub.sh`) does the full
> tested flow from a Mac against the Unraid daemon over SSH — snapshots the current
> `:latest` as a `pre-deploy-<id>` rollback tag, builds, cuts over (`compose up -d`),
> and verifies health + the public endpoint. It wraps the build in **`caffeinate`**
> so an idle-sleeping Mac can't drop the `DOCKER_HOST=ssh` pipe mid-build (which
> otherwise hangs the local `docker` CLI forever while the remote quietly finishes).
> `SKIP_CUTOVER=1 npm run deploy:hub` builds only. Override `SSH_HOST`/`IMAGE`/etc via env.

## 2. Path A — Unraid container template

Add a container (Docker tab → Add Container) with:

| Field            | Value                                                        |
|------------------|-------------------------------------------------------------|
| Repository       | `<registry>/hidock-hub:<tag>`                               |
| Network Type     | the same custom bridge NPM is on (so NPM can reach it by name), or `bridge` |
| Port             | Container `8788` → Host `8788` (only needed if NPM targets host:port) |
| Restart Policy   | `unless-stopped`                                            |

### Volume mapping (the /data appdata mount)

| Container Path | Host Path                              | Mode |
|----------------|----------------------------------------|------|
| `/data`        | `/mnt/user/appdata/hidock-hub`         | RW   |

This single mount holds the SQLite DB, recordings, transcripts, and
`config.json`. Back up `/mnt/user/appdata/hidock-hub` to back up everything.
The container runs as the `node` user (uid 1000); ensure the appdata dir is
writable by uid 1000 (Unraid's default appdata perms usually are; if not,
`chown -R 1000:1000 /mnt/user/appdata/hidock-hub`).

### Environment variables

| Variable               | Required | Example / Notes                                   |
|------------------------|----------|---------------------------------------------------|
| `GOOGLE_CLIENT_ID`     | yes      | `…apps.googleusercontent.com`                     |
| `GOOGLE_CLIENT_SECRET` | yes      | from Google Cloud Console                         |
| `PUBLIC_URL`           | yes      | `https://hub.example.com` (your NPM domain)       |
| `SESSION_SECRET`       | yes      | `openssl rand -hex 24` (≥16 chars)                |
| `ADMIN_EMAIL`          | no       | first admin; defaults to `rogercoxjr@gmail.com`   |
| `PORT`                 | no       | `8788` (match the container port)                 |
| `HIDOCK_DATA_ROOT`     | no       | keep `/data`                                      |
| `HIDOCK_SECRET_KEY`    | no       | `openssl rand -hex 32`; encrypts API keys at rest |
| `OLLAMA_URL`           | no       | `http://<unraid-ip>:11434` or `http://ollama:11434` |

> `localhost` inside the container is NOT the Unraid host. Point `OLLAMA_URL` at
> the host IP or a sibling Ollama container. If you run the Ollama Unraid app,
> use the same custom network and `http://<ollama-container-name>:11434`. The
> value is written to `config.embeddings.ollamaBaseUrl` at boot.

## 2b. Path B — docker compose via SSH (alternative to §2)

Instead of the Unraid UI template, put the deployment in a `docker-compose.yml`
+ `.env` under a server-side dir. The compose file is already in the repo at
`apps/electron/docker-compose.unraid.yml`.

> **`npm run deploy:hub` uses `/mnt/user/appdata/hidock-hub-deploy/` by default**
> (`REMOTE_DIR`). It builds the image on the remote daemon, ships the compose
> file there, and runs `docker compose -p hidock-hub up -d` **on the server**, so
> the container's env comes from *that dir's* `.env` — never the deploy machine's
> `.env`. This is deliberate: it stops a dev box's `.env` (e.g. a `localhost`
> `PUBLIC_URL`, which breaks Google OAuth with "no login in progress") from being
> injected into production. Provision that dir's `.env` once (below); the deploy
> then fails fast if it's missing.
>
> Note: `PUBLIC_URL` is **pinned in the compose file** (`environment:`, a non-secret,
> deployment-fixed value), so it overrides `.env` — the server `.env` only needs the
> **secrets** (`GOOGLE_CLIENT_ID/SECRET`, `SESSION_SECRET`, `HIDOCK_SECRET_KEY`,
> `ADMIN_EMAIL`, `OLLAMA_URL`). Change the pinned domain in the compose file, not `.env`.

SSH to Unraid, then:

    mkdir -p /mnt/user/appdata/compose/hidock-hub
    cd /mnt/user/appdata/compose/hidock-hub

    # Copy the compose file from the repo (scp/rsync from your workstation, or
    # `curl` from GitHub raw). Rename it to docker-compose.yml so `docker compose`
    # finds it without a -f flag:
    #   scp apps/electron/docker-compose.unraid.yml \
    #       root@<unraid-ip>:/mnt/user/appdata/compose/hidock-hub/docker-compose.yml
    #
    # Same for .env — copy .env.example, rename to .env, fill secrets:
    #   scp apps/electron/.env.example root@<unraid-ip>:/mnt/user/appdata/compose/hidock-hub/.env

    vi .env               # fill in GOOGLE_CLIENT_ID/SECRET, PUBLIC_URL, SESSION_SECRET, HIDOCK_SECRET_KEY
    chmod 600 .env        # secrets — restrict read access

    docker compose up -d
    docker compose ps                       # container should show "healthy" after ~30s
    curl http://127.0.0.1:8788/healthz      # → {"status":"ok"}

For updates (when a new image tag lands):

    docker compose pull && docker compose up -d

Notes:

- Compose-managed containers still show in the Unraid Docker tab (name, log
  button, status) — but the UI's "Edit" button doesn't understand compose. Use
  `docker compose` for all lifecycle actions, not the Unraid Edit dialog.
- The default image tag in the compose file is `:latest`. For a pinned deploy,
  set `HIDOCK_IMAGE=rogercoxjr/hidock-hub:0.1.0` in `.env` (the compose file
  reads it as `${HIDOCK_IMAGE:-…}`).
- Autostart on host boot: `restart: unless-stopped` handles this — Docker
  brings the container back when the daemon starts. No Unraid autostart
  checkbox needed.

## 3. Start it

Apply the template (Path A) or `docker compose up -d` (Path B). Check the
container log for `app.listen` success and hit the healthcheck:
`curl http://<unraid-ip>:8788/healthz` → `{"status":"ok"}`.
(Direct host access bypasses TLS — fine for a smoke test; real access is via NPM.)

## 4. Reverse proxy & OAuth

See `DEPLOY-NPM.md` for the nginxproxymanager proxy host (TLS, WebSocket, upload
tuning) and the Google OAuth redirect URI. **Do those before sign-in works.**

## Notes on hosted-mode feature scope (Phase 0)

- **Device sync** is a Phase-1 feature: the HiDock plugs into the *browsing
  machine* and syncs via in-browser WebUSB, not into the server. The server
  never opens USB.
- **Voiceprint capture / speaker matching** uses Electron's `utilityProcess`
  embedding worker, which is unavailable under plain Node. Those endpoints
  degrade gracefully (the feature is a desktop/Phase-2 capability); everything
  else — library, transcription, summaries, RAG chat, calendar, contacts,
  projects — runs server-side.
