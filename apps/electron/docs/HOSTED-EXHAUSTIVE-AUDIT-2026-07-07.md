# Hosted-mode exhaustive audit (round 2) — 2026-07-07

Second, broader multi-agent audit (after the 13-fix round 1) covering dimensions round 1 didn't: electron-reachability per route, query/PATCH/error-shape contracts, auth coverage, WS contract, facade reachability, boot/registration completeness. Every finding adversarially verified. **64 agents, 29 flagged, 3 confirmed.**

## Clean dimensions (0 confirmed) ✅
- **electron-reachability (per route):** no route handler reaches an `electron` import via static or dynamic path. *(Caveat: this scoped to route→import chains. The known voiceprint `electron` leak is reached via the transcription **processor** pipeline (sync→transcription→voiceprint), not a direct route handler, so it's outside this dimension's framing — still tracked as an open follow-up; make voiceprint capture hosted-safe or gate it.)*
- **auth coverage:** every mutating route has `[requireAuth, requireSameOrigin]`; data GETs have `requireAuth`; only healthz/auth/static public.
- **WS contract:** broadcast channels ↔ renderer subscriptions aligned.
- **facade reachability:** no renderer call to an uncomposed/missing facade method (post Class-B, stubs are benign).
- **registration:** every route registered in `app.ts`; every group composed in `index.ts`; static SPA last.

## Confirmed contract findings (3)

### C1 — `rag.globalSearch` wrong route → Explore page crash (HIGH)
SDK `groups/rag.ts:99` calls `GET /api/rag/search`, which returns a **bare array** `[{content,meetingId,subject,score}]`. The route that returns `{knowledge,people,projects}` is `GET /api/rag/global-search` (`routes/rag.ts:235`). `Explore.tsx:182-183` reads `results.knowledge.length` on the array → `Cannot read properties of undefined (reading 'length')` on every successful search. Also `scope=global` query param is silently stripped (route schema has no `scope`).
**Fix:** point SDK at `/api/rag/global-search`; drop/align the `scope` param to the route's query schema.

### C2 — `recordings.resummarize` bodyless POST → always 400 (HIGH)
SDK `groups/recordings.ts:256` does `http.post(.../resummarize)` with no body → Fastify `req.body === undefined` → route `resummarizeBody.parse(undefined)` throws (zod: expected object) → 400 `{error:'invalid'}` → SDK returns `{success:false}` even for a valid recording. Route tests miss it (they always send `payload:{}`).
**Fix:** SDK sends `{}` (aligned) AND/OR route uses `resummarizeBody.parse(req.body ?? {})` (hardens the whole bodyless-POST class). Do the SDK fix; harden the route too since `templateId` is optional.

### C3 — `projects.update` `description: null` → 400 silent no-op (MEDIUM)
`Projects.tsx:230` sends `description: editDescription.trim() || null` when clearing the field. Route `routes/projects.ts:35` schema is `z.string().optional()` — zod `.optional()` admits only `undefined`, so `null` fails parse → 400 → `handleSaveDescription`'s `if(result.success)` skipped, no throw → description not cleared, no error shown. DB + the `UpdateProjectRequest` type both allow null.
**Fix:** route `description: z.string().nullable().optional()` (and `createBody` for symmetry).

## Notes
- All 3 are the same SDK↔route drift class round 1 targeted; the Layer-2 **contract harness** (being built) catches this class generically going forward.
- `rag.globalSearch` (C1) is the finding whose verifier **died** in round 1 — round 2's independent verify caught it. Redundant verification matters.
