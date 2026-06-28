# electron-api SDK — Operator Live-Validation Checklist (Phase 0e)

This document is the **deferred live-validation pass** for the renderer REST/WS client SDK
built in 0e Tasks 4–11. Run these steps against a running 0f deployment (server + browser)
to confirm the SDK wires correctly before declaring Phase 0 complete.

---

## Prerequisites

- The 0b OIDC server is running (or a dev instance with `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`).
- The 0c REST + 0c-1 WS server is running (same origin as the renderer, or proxied by 0f).
- You have a valid Google account in the allowed-invite list.
- Chrome and Edge are both available (cross-browser cookie check).
- At least one recording exists in the database (upload one via the UI if needed).

---

## 1. Authentication (0b OIDC) — Chrome + Edge

1. Open the app URL in **Chrome**. Confirm you are redirected to `/auth/login` (not the app shell).
2. Click **Sign in with Google**. Complete the OAuth flow.
3. Confirm you land on the app shell (Library page).
4. Open **Edge**, repeat steps 1–3. Confirm both sessions are independent.

**What to watch for:**
- `Set-Cookie: session=…; SameSite=Lax; HttpOnly` in the login callback response (DevTools → Network).
- The app shell loads without a blank screen or infinite loop.

---

## 2. Cookie rides every fetch (credentials: 'include')

1. Open DevTools → Network.
2. Navigate to any page that loads data (Library, People, Calendar).
3. Pick any `GET /api/*` request. Confirm the **Cookie** request header is present and contains the session token.
4. Repeat for a POST request (e.g. trigger a transcription or export).

**Expected:** Every API request carries the session cookie automatically — no explicit Authorization header needed.

---

## 3. WebSocket upgrade — cookie auth + events

1. Open DevTools → Network → filter by **WS**.
2. Confirm a single `GET /ws` upgrade request is visible, with status `101 Switching Protocols`.
3. Confirm the **Cookie** header is present on the upgrade request.
4. Trigger a transcription (via the UI). Confirm the following WS frames arrive in the Messages panel:
   - `transcription:started`
   - `transcription:progress` (one or more)
   - `transcription:completed` (or `transcription:failed`)
5. Close the browser tab and reopen. Confirm the WS reconnects automatically (exponential backoff — first retry in ~1 s).

---

## 4. Read (RAW-THROW / RESULT)

1. Navigate to the Library page. Confirm recordings load (calls `GET /api/recordings`).
2. Open a recording detail. Confirm the transcript renders (calls `GET /api/recordings/:id/transcript`).
3. Navigate to People. Confirm contacts load (calls `GET /api/contacts`).

**On failure:** Check the browser console for `TypeError: Failed to fetch` (CORS / proxy misconfiguration) or a 4xx/5xx with a JSON error body.

---

## 5. RESULT write

1. Open a recording that has been linked to a meeting. Edit the meeting title via the **Edit** affordance.
2. Save. Confirm the title updates without a page reload.
3. Open DevTools → Network. Confirm `PATCH /api/meetings/:id` returned 200 with `{ success: true, data: … }`.

---

## 6. STRING|FALSE action (transcription queue)

1. Select a recording that has not been transcribed.
2. Click **Transcribe**. Confirm the transcription progress banner appears.
3. Open DevTools → Network. Confirm `POST /api/recordings/:id/transcribe` returned 200 with a queue-item ID string (not `false`).

**On failure (returns false):** Check the server log for `recordings.transcribe` — a `false` return means the server returned a non-2xx or a body without an `id` / `queueItemId` field.

---

## 7. INLINE action (select meeting / getCandidates)

1. Open a recording that is not linked to a meeting.
2. Click **Link to meeting**. Confirm the candidate meetings dialog opens and shows nearby meetings.
3. Select a meeting and confirm. Confirm `{ success: true }` is returned (no error banner).
4. Open DevTools → Network. Confirm `POST /api/recordings/:id/select-meeting` returned 200.

---

## 8. Transcript export (browser download)

1. Open a recording with a transcript.
2. Click the **Export…** dropdown. Select **JSON**.
3. Confirm the browser's native download dialog opens (or the file is saved to the Downloads folder).
4. Confirm the downloaded file is valid JSON.
5. Repeat with **CSV** (requires diarization) and **SRT** (requires diarization) if a diarized transcript is available.

**On failure:** Check DevTools → Network for `POST /api/recordings/:id/transcript/export?format=json`. A 4xx means the server-side export route is not wired. A CORS error means the `/api` proxy is misconfigured.

---

## 9. Upload (multipart POST)

1. Navigate to Library. Click **Add external recording** (or the upload affordance).
2. Select a local audio file via the OS file picker (`<input type=file>`).
3. Confirm the upload progress indicator appears and the recording appears in the Library on completion.
4. Open DevTools → Network. Confirm `POST /api/recordings/upload` carried a `multipart/form-data` body and returned 201.

---

## 10. WebSocket events arrive + survive reconnect

1. Trigger a transcription (start one or let a queued one run).
2. In DevTools → Network → WS Messages, confirm `transcription:progress` frames arrive in real time.
3. While the transcription is running, disconnect your network adapter for ~5 seconds, then reconnect.
4. Confirm the WS reconnects automatically and the in-flight progress resumes (or completes after reconnect).

---

## 11. 0d media URL — audio playback + range scrubbing

1. Open a recording detail that has a local audio file.
2. Click **Play**. Confirm audio plays via the `<audio>` element pointing to `GET /api/recordings/:id/media`.
3. Scrub the seek bar to a middle position. Confirm the server handles the HTTP **Range** request (DevTools → Network → look for `206 Partial Content` with `Content-Range` header).
4. Confirm playback resumes from the scrubbed position without downloading the entire file.

---

## 12. Phase-1 device path — WebUSB picker (unchanged)

1. Connect a HiDock device.
2. Open the **Device** page. Confirm the WebUSB browser picker appears (or the device is already connected).
3. Confirm file listing, sync status, and download flow work as before.
4. Confirm no JS errors appear in the console related to `jensen.*` or `downloadService.*` SDK stubs (these are no-op stubs — they should not crash the UI; errors are expected only on explicit device operations when Phase 1 is not wired).

---

## 13. CORS / proxy gotchas for 0f

When deploying behind a reverse proxy (Nginx, Caddy, etc.) for 0f:

- **Cookie SameSite:** The proxy must serve the app and the API on the **same origin** (or set `SameSite=None; Secure`).
- **WebSocket upgrade:** The proxy must forward `Upgrade: websocket` and `Connection: upgrade` headers.
- **WSS (TLS):** Use `wss://` in production. The `WsClient` in `ws.ts` auto-detects `window.location.protocol === 'https:'` and switches to `wss:`.
- **Range requests:** The proxy must not buffer the entire response for `GET /api/recordings/:id/media` — ensure `proxy_buffering off` (Nginx) or equivalent.
- **CSRF:** The 0b session cookie is `HttpOnly; SameSite=Lax`. For cross-origin deployments (API on a different subdomain), upgrade to `SameSite=None; Secure` and add a CSRF token middleware.

---

## 14. 401 redirect smoke test

1. Delete the session cookie in DevTools → Application → Cookies.
2. Trigger any API call (e.g. navigate to People).
3. Confirm you are redirected to `/auth/login` (not a blank screen or JSON error).

---

## Pass criteria

All 14 checks pass with no console errors from the SDK layer. File any failures as issues against `apps/electron` tagged `0e-validation`.
