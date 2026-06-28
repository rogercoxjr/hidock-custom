# Deploying the HiDock Hosted Hub on Unraid (behind nginxproxymanager)

This is the **operator runbook**. The image is the multi-stage build from
`apps/electron/Dockerfile`. The agent that wrote this cannot perform these steps
— they need the Unraid host, a domain, and a Google OAuth client.

## 1. Build & publish the image

On a build host (or Unraid with the Docker buildx plugin), from `apps/electron/`:

    DOCKER_BUILDKIT=1 docker build -t <registry>/hidock-hub:<tag> .
    docker push <registry>/hidock-hub:<tag>

(Or build locally on Unraid and reference the local image tag.)

## 2. Unraid container template

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

## 3. Start it

Apply the template. Check the container log for `app.listen` success and hit the
healthcheck: `curl http://<unraid-ip>:8788/healthz` → `{"status":"ok"}`.
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
