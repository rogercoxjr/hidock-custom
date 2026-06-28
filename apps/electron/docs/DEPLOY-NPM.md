# nginxproxymanager (NPM) config for the HiDock Hosted Hub

NPM sits in front of the container: it terminates HTTPS with a Let's Encrypt cert
and proxies to the hub on port 8788. **These are operator steps** — they need the
domain, DNS, and the running container.

## 1. Proxy Host (Details tab)

| Field                  | Value                                                     |
|------------------------|----------------------------------------------------------|
| Domain Names           | `hub.example.com` (must equal `PUBLIC_URL`'s host)       |
| Scheme                 | `http`                                                    |
| Forward Hostname / IP  | the container name (if NPM is on the same docker network) or the Unraid host IP |
| Forward Port           | `8788`                                                    |
| Cache Assets           | off (the SPA is already hash-cached; avoid stale shells)  |
| Block Common Exploits  | on                                                        |
| **Websockets Support** | **ON** ← required for `/ws` (see §3 if the toggle isn't enough) |

## 2. TLS (SSL tab)

- SSL Certificate → **Request a new SSL Certificate** (Let's Encrypt).
- **Force SSL: ON** (redirect http→https).
- **HTTP/2 Support: ON.**
- Agree to the Let's Encrypt ToS; DNS for `hub.example.com` must already resolve
  to the NPM host and ports 80/443 must reach NPM for the ACME challenge.
- `PUBLIC_URL` MUST be `https://hub.example.com` (https, exact host). The server
  sets the session cookie `secure: true` (`startServer` passes `cookieSecure: true`),
  so the cookie only travels over HTTPS — TLS at NPM is mandatory, not optional.

## 3. WebSocket Upgrade passthrough for /ws

The "Websockets Support" toggle adds the standard upgrade headers globally. If
the `/ws` endpoint (the WS broadcaster) still fails to upgrade, add an explicit
location in the proxy host's **Advanced** tab:

    location /ws {
        proxy_pass http://$forward_scheme://$server:$port;  # NPM fills these
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;   # long-lived WS; don't time out idle sockets
        proxy_send_timeout 3600s;
    }

(With the toggle ON, the global config usually suffices; this block is the
fallback. The server runs Fastify with `trustProxy: true`, so it honors
`X-Forwarded-*`.)

## 4. Large-upload proxy tuning

Recording uploads can be large (`@fastify/multipart` allows up to 500 MB). NPM's
nginx defaults cap the body well below that. In the **Advanced** tab add (or set
in NPM's global config):

    client_max_body_size 0;        # 0 = no nginx-side limit; the app enforces 500MB
    proxy_request_buffering off;    # stream large uploads through, don't buffer to disk
    proxy_read_timeout 3600s;       # allow slow/large uploads + long transcriptions
    proxy_send_timeout 3600s;

> `client_max_body_size 0` defers the limit to the app (Fastify's 500 MB). If you
> prefer a hard proxy cap, set it slightly above 500m, e.g. `client_max_body_size 520m`.

## 5. Google OAuth redirect URI

In Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 Client
(Web application):

- **Authorized JavaScript origins:** `https://hub.example.com`
- **Authorized redirect URIs:** `https://hub.example.com/auth/callback`
  ← this is `${PUBLIC_URL}/auth/callback` — the exact route the server registers
  (`server/auth.ts` `GET /auth/callback`; the redirect_uri is built from
  `PUBLIC_URL` in `server/oidc.ts`). Must be https, exact host, no trailing-slash
  mismatch — Google matches it literally.

The flow: user hits `https://hub.example.com` → SPA → `GET /auth/login` → Google
→ redirect back to `/auth/callback` on the SAME public URL → session cookie set
(secure, over TLS) → `allowed_users` gate → app. (The SPA's REST client redirects
to `/auth/login` automatically on any 401.)

## 6. Operator verification checklist (cannot be automated)

- [ ] `https://hub.example.com/healthz` returns `{"status":"ok"}` over a valid cert.
- [ ] `https://hub.example.com/` loads the SPA shell.
- [ ] DevTools → Network → WS shows `/ws` connected (status 101), not failing.
- [ ] A real Google sign-in completes and lands in the app (redirect URI matches).
- [ ] A large recording upload succeeds (no nginx 413).
