# syntax=docker/dockerfile:1.7
# HiDock Hosted Hub — single-image server: built SPA + REST/WS API on one port.
# Build context: apps/electron/  (build from that directory).

# ---------------------------------------------------------------------------
# Stage 1: spa-build — build the React SPA with electron-vite/vite.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS spa-build
WORKDIR /app
# Install ALL deps (dev included) — vite/electron-vite are devDependencies.
# --ignore-scripts: skip electron-builder install-app-deps (Electron-ABI rebuild
# we do NOT want; the SPA build needs no native modules).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
# electron-vite build emits main + preload + renderer; we only keep out/renderer.
RUN npm run build
# Sanity: the SPA must exist.
RUN test -f out/renderer/index.html

# ---------------------------------------------------------------------------
# Stage 2: server-build — bundle electron/server/index.ts -> out/server/ (esbuild,
# code-split; entry out/server/index.js + lazy chunks + type:module marker).
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS server-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build:server
RUN test -f out/server/index.js

# ---------------------------------------------------------------------------
# Stage 3: native-deps — production install with native modules compiled for the
# RUNTIME Node (node:22), NOT Electron.
#
# WHY --ignore-scripts then explicit rebuild: package.json's postinstall is
# `electron-builder install-app-deps`, which rebuilds better-sqlite3/sodium-native
# against ELECTRON's Node ABI. Under plain Node that yields NODE_MODULE_VERSION
# mismatches at require() time. We skip that postinstall and let the native
# modules build/select prebuilds against THIS image's Node.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS native-deps
WORKDIR /app
# Build toolchain for native compilation (better-sqlite3 builds from source if no
# prebuild matches; sodium-native/usb ship prebuilds via node-gyp-build).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Production deps only; skip the Electron-ABI postinstall.
RUN npm ci --omit=dev --ignore-scripts
# Rebuild the native deps against THIS image's plain Node ABI.
# better-sqlite3: compiled (or prebuild for node22 linux-x64).
# sodium-native / usb: node-gyp-build picks the matching prebuild.
# ffmpeg-static: its install script downloads the linux-x64 ffmpeg binary; run it.
RUN npm rebuild better-sqlite3 \
    && npm rebuild sodium-native \
    && node node_modules/ffmpeg-static/install.js
# usb is optional for the server (device access is a browser gesture in hosted
# mode). If its native build is absent, the server must still run — do not fail.
RUN npm rebuild usb || echo "[native-deps] usb rebuild skipped (not required server-side)"
# Phase 2 (optional): sherpa-onnx-node is an optionalDependency; tolerate failure.
RUN npm rebuild sherpa-onnx-node 2>/dev/null || echo "[native-deps] sherpa-onnx-node not installed (Phase 2)"
# Smoke-load the must-have native modules to fail the build early on ABI mismatch.
RUN node -e "require('better-sqlite3'); require('sodium-native'); console.log('native ABI OK')"

# ---------------------------------------------------------------------------
# Stage 4: runtime — slim image, no toolchain, no dev deps, no source.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8788 \
    HIDOCK_DATA_ROOT=/data \
    HIDOCK_SPA_DIR=/app/out/renderer
# Production node_modules with runtime-ABI native deps.
COPY --from=native-deps /app/node_modules ./node_modules
# Built server bundle (entry + lazy chunks + type:module package.json) + sourcemaps.
COPY --from=server-build /app/out/server ./out/server
# Built SPA.
COPY --from=spa-build /app/out/renderer ./out/renderer
# package.json present so node resolves "type"/exports correctly for the bundle.
COPY package.json ./

# /data holds the SQLite db, recordings, transcripts, config.json — bind to a
# host path (Unraid appdata) at run time.
VOLUME /data
EXPOSE 8788

# Run as the non-root 'node' user shipped in the base image; ensure it owns /data.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

# Container healthcheck hits the same /healthz the orchestrator/NPM can use.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "out/server/index.js"]
