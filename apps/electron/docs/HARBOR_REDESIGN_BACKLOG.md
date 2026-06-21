# Harbor "Royal Forrest" Redesign — Deferred Items Backlog

The full app was re-skinned onto the Harbor design system (light-first; dark tokens present + working theme toggle). The items below were intentionally deferred during the re-skin — mostly because the prototype shows data the app's current model/IPC doesn't expose yet, or because they're out of "presentation-only" scope. Each notes *why* and *where to wire it*.

## P1 — Data wiring that lights up already-built UI
These have the UI/affordances in place (or trivially so); they just need a real data source.

1. **VoiceMarks (device-flagged moments)**
   - Prototype shows a VoiceMark rail in the transcript and a "Recently flagged" list on Home. No renderer-side voicemark/flag data source exists today.
   - Home currently substitutes a **"Recently transcribed"** card (`src/pages/Home.tsx`). Swap it back to flagged VoiceMarks once a marks source/IPC lands.
   - Likely needs: a marks table/field on recordings or turns + an IPC to read them. Per project memory, VoiceMarks are a real device concept ("flagged on device") from the diarization work — surface them to the renderer.

2. **People pills + per-source label chips on captures**
   - Prototype source cards/rows show attendee pills and colored label dot-chips. `UnifiedRecording` has neither `people[]` nor `labels[]`.
   - Wire when: meeting-correlation attendees are exposed on the unified recording, and a labels/tags-by-source field exists. Files: `src/features/library/components/SourceRow.tsx`, `SourceCard.tsx`.

3. **Voiceprint badge + count on People / PersonDetail**
   - Prototype shows a teal wave badge on contacts that have an enrolled voiceprint, plus a "{N} voiceprints" meta. The `contacts:getAll` payload (electron `contacts-handlers.ts`) returns no voiceprint-presence/count field.
   - Wire when: the contacts list query/mapping includes a `hasVoiceprint`/`voiceprintCount`. Files: `src/pages/People.tsx`, `src/pages/PersonDetail.tsx` (PersonAvatar already supports a badge slot pattern).

## P2 — New features the prototype implies (not built)
4. **Settings → Smart Labels / category manager**
   - Prototype has an AI-label manager (per-label color, auto-apply toggle, add/remove). No such feature or config key exists in the app.
   - Build: a labels feature (config schema + IPC CRUD + Settings UI). Today only read-only source classification exists (Library/Explore filters).

5. **Live capture page**
   - Nav item dropped this pass; prototype marks it "soon". Add a `/live` route + page when live capture ships.

## P3 — Polish / hygiene
6. **Dark-mode QA pass** — Light is verified per-page; dark tokens exist and the Settings toggle works, but dark has not been visually QA'd screen-by-screen. Do a dark pass (watch for any remaining non-token chrome).

7. **Dead components** — `src/features/library/components/SourceDetailDrawer.tsx` and `SourceRowExpanded.tsx` are imported but **not rendered** (SourceReader.tsx ~line 110 comment confirms). They were left un-reskinned (invisible) and **not deleted**. Decide: remove them + their tests, or keep.

8. **Pixel-fidelity tightening** — Some one-off prototype px values were mapped to the nearest Harbor token. A side-by-side pass against `HiDock - Royal Forrest Redesign.dc.html` could tighten spacing/sizes on key screens (Library reader, Home).

9. **Theme options** — A working Light/Dark/System toggle ships in Settings → Appearance (default Light). If you truly want light-only for now, hide the Dark/System options (the tokens stay).

10. **Lint warnings** — `npm run lint` reports ~1012 warnings (0 errors): mostly pre-existing `react-hooks/exhaustive-deps`; a few new `react/no-unescaped-entities` from prototype copy (apostrophes). A sweep would clear them.

11. **Pre-existing `typecheck:node` failure (unrelated to redesign)** — `electron/main/services/__tests__/chat-provider.test.ts` fails because its `AppConfig` mock is missing `transcription.diarization`. Add that field to the mock to green the node typecheck gate. (`typecheck:web` is fully clean.)

---
*Generated as part of the Harbor redesign. Verification at commit time: `typecheck:web` clean · lint 0 errors · `npm run build` clean (6 self-hosted woff2 bundled) · `npm run test:run` 2037/2037 passing · 0 residual raw-palette utility classes in live code.*
