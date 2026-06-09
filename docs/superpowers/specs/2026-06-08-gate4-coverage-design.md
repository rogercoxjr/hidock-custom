# Gate 4 Design — Restore a Meaningful Desktop Python Coverage Gate

**Scope:** `apps/desktop/` (Python).
**Status:** Approved design (no code written yet).
**Date:** 2026-06-08.
**Context:** Gate 4 of the "primetime" effort. The original milestone label was "desktop Python coverage 13% → 80%." This design re-scopes that to an achievable, honest bar (see §4). Facts cited inline were verified against the live repo during assessment, not assumed.

---

## 1. Baseline — honest current state

There are two coverage numbers in circulation and the gap is load-bearing:

| Number | Source | What it measures |
|---|---|---|
| **~13%** | Readiness memory / original Gate-4 framing | An earlier/narrower measurement. The number the *milestone* was labelled with. |
| **~33%** | Clean assessment run | `pytest tests --cov=. -q` with the two hung files excluded — **5,587 / 17,012 statements**. |

**Reconciliation:** treat **~33% as the real measured floor** and **13% as a stale milestone label**. Do not present 33% as a 20-point gain over 13% — they are different measurement scopes. The actual floor we ratchet from MUST be **re-measured in one clean pass at Gate-4 kickoff** (after un-hanging the two excluded files), not taken from either number.

**There is no coverage gate today.** The active `apps/desktop/pyproject.toml` has `--cov=.` + reports but **no `fail_under`**. `--cov-fail-under=80` was removed in commit `c92c9993`; a stale copy survives only in the non-active `apps/desktop/config/pyproject.toml`. "Restore a meaningful gate" therefore means *add* one.

**Test results (clean run, hung files excluded):** **63 failed · 1,207 passed · 18 skipped** (286s). Pass rate among non-skipped ≈ **95.0%**.

**Hard blockers (verified):**
- **B1 — Two test files hang the suite with no watchdog.** `test_hidock_device_file_operations.py` and `test_hidock_device_connection.py` are excluded from every run. `pytest-timeout` is **not installed**, so a runaway loop hangs the whole run silently. These files cover `hidock_device.py` (the protocol core, ~664 missing lines), so excluding them structurally suppresses coverage on the most important module — no honest whole-app number exists until they run.
- **B2 — 63 failures must be green before any gate is enforced.** A `fail_under` gate is meaningless while tests fail.
- **B3 — 0%-covered modules skew the denominator** (`jensen_protocol_extensions.py` = dead/disabled stub; `oauth2_token_manager.py` = live Class-A logic that simply lacks tests).

**Not verifiable in this environment:** real Outlook/COM behavior, real Gemini network calls, real USB hardware. None of the 63 failures *require* those (all are mock-drift), but end-to-end correctness of the Outlook/Gemini/USB paths can only be checked as internally-consistent mocked contracts here.

---

## 2. Family A — the ~39 calendar/Outlook tests (the "Outlook blocker")

Three sub-problems with three different right answers:

- **A-a — `test_simple_calendar_mixin_coverage.py` (25): the module is gone.** `simple_calendar_mixin.py` exists nowhere in the repo; the tests fail at import and **cover nothing**. **→ Delete the file.** (Salvage individual cases only if a 1:1 surviving target exists; assessment found none.) This raises suite trustworthiness, not a coverage loss.
- **A-b — `test_async_calendar_mixin.py` (13): harness drift, not a COM dependency.** `async_calendar_mixin.py` imports `create_simple_outlook_integration` inside a `try` (line 21) and instantiates it lazily (line 64) — the COM layer is an injectable seam. Failures are `AttributeError: ... 'mock_gui'` (a harness fixture that no longer exists). **→ Fix in place:** restore the harness fixture, patch the seam to return a `Mock`. No real Outlook / win32com / display needed.
- **A-c — `test_outlook_calendar_service.py::test_authenticate_failure` (1): assertion drift.** `assert <Mock Account()> is None` — the failure path no longer nulls `self.account`. **→ Fix in place:** assert on the current failure signal.

**Family-A decision: do NOT defer or env-gate-and-skip.** Delete A-a (25), fix A-b (13) + A-c (1) with mocks — all achievable here. Real-Outlook E2E is a separate, explicitly out-of-scope manual-QA item.

---

## 3. The two hung files

Static analysis: both hangs are **pure-Python loop / wall-clock**, **not** USB probing — every test already patches `usb.core.find` / `_send_command` / `_receive_response`, so no real hardware is touched (consistent with the CLAUDE.md USB-safety rules; do **not** "fix" by touching a device).

Recommended handling, in order:
1. **Add `pytest-timeout`** to desktop dev deps; apply module-level `pytestmark = pytest.mark.timeout(10)` to both files. Highest-value, lowest-risk: a runaway loop now fails fast and surfaces the real assertion instead of hanging CI. (Belongs in Slice 0.)
2. **`test_hidock_device_file_operations.py`** — make `list_files` mocks terminate deterministically: finite `_receive_response` `side_effect` ending in an empty body `{"id": CMD_GET_FILE_LIST, "body": b""}`; for `stream_file` empty-chunk paths, patch `hidock_device.time.sleep`/`time.time` with finite increasing `side_effect`. **Test-only.**
3. **`test_hidock_device_connection.py`** — give the success-path mock `ep_in.read` a terminating `side_effect = usb.core.USBTimeoutError(...)` so the post-connect flush loop exits via its intended break. **Test-only.**
4. **Production loop-hardening is OUT OF SCOPE for Gate 4.** The latent infinite loops in `_attempt_connection` and `list_files`' `else: continue` branch are real but are behavior changes — file them as a **separate reviewed production PR**.

Net effect: both files re-enter the suite, `hidock_device.py` coverage becomes measurable, and the true whole-app floor can be computed for the first time.

---

## 4. Coverage-gate strategy (approved re-scope)

**A two-part gate. Do NOT attempt 80%-whole-app.**

80%-whole-app is **structurally impossible headless**: the largest files are Class-B GUI (`gui_main_window.py` 5,315 LOC / 1,483 missing; `settings_window.py` 2,307 LOC / 835 missing; all `gui_*`) needing a display, plus Class-D real-Outlook/COM. Covering those to 80% needs a display server + real Outlook this CI track does not have.

1. **Whole-app ratchet floor.** After the 63 failures are green and the two hung files re-included, re-measure in one clean pass and set `fail_under = (measured floor − 1)`, rounded down (1-point flake margin). **Ratchet upward only** — every PR that adds tests bumps the floor. Immediate regression net without blocking on an unreachable absolute.
2. **Hard 80% on a critical, fully-mockable allowlist** (the real quality bar) — verified display-free / hardware-free Class-A modules: `file_operations_manager.py`, `storage_management.py`, `audio_metadata_db.py`, `device_interface.py`, `hta_converter.py`, `calendar_cache_manager.py`, `calendar_filter_engine.py`, `gemini_models.py`, `oauth2_pkce.py`, `oauth2_token_manager.py`, `config_and_logger.py`, pure slices of `desktop_device_adapter.py`, and the pure protocol helpers of `hidock_device.py` (`_build_packet`, checksum, 24-bit body-length parsing). Enforced via a scoped `coverage report --include=...` CI step.

Rejected alternatives: "hold-until-80%-whole-app" blocks the gate forever on display/COM code; a bare ratchet alone is too weak (could sit at 33% indefinitely). The combined gate gives an immediate regression net **plus** a meaningful 80% bar on code that is testable here.

---

## 5. Ordered work breakdown (subagent-sized slices)

✅ = achievable in this environment (no display/Outlook/USB hardware). Test/config-only unless noted.

| # | Slice | Scope | Effort | Here? |
|---|---|---|---|---|
| **0 ⭐ FIRST** | Timeout net + un-hang the 2 files + TRUE baseline | Add `pytest-timeout`; `timeout(10)` marker on both files; make their mocks terminate deterministically (§3); run the full suite *including* both files once to capture the real floor. | ~1 session | ✅ |
| **1** | Delete dead calendar tests (A-a) | Remove `test_simple_calendar_mixin_coverage.py` (25 dead tests). | ~½ session | ✅ |
| **2** | Fix Family A live tests | `test_async_calendar_mixin.py` (13, mock the lazy COM seam) + `test_outlook_calendar_service.py` (1, realign assertion). | ~1 session | ✅ (mock-only) |
| **3** | Fix Family B AI/transcription mock-drift | `test_ai_service.py` (7), `test_ai_service_focused.py` (1), `test_transcription_module.py` (~12–15). Realign mocks to the new `google-genai` 2.8.0 SDK (`from google import genai`). | ~1 session | ✅ (no network) |
| **4** | Fix the 1 connection-recovery contract test | `test_connection_recovery_integration.py::test_connection_recovery_after_error` — mock backend / assert current adapter contract. | ~¼ session | ✅ |
| **5** | Net-new Class-A coverage (highest ROI) | New tests for `oauth2_pkce.py`, `gemini_models.py`, `calendar_filter_engine.py`, `calendar_cache_manager.py`, `audio_metadata_db.py` (currently untested, all mockable). | ~1–2 sessions | ✅ |
| **6** | Branch/edge top-up on Tier-1 A modules | Push `file_operations_manager.py`, `storage_management.py`, `device_interface.py`, `hta_converter.py`, `desktop_device_adapter.py` pure slices, `hidock_device.py` protocol helpers toward the 80% allowlist bar. | ~2–3 sessions | ✅ |
| **7** | Install + measure the gate | Re-measure clean; set `fail_under = floor−1` (ratchet) + the critical-allowlist 80% check; wire both into CI. | ~½ session | ✅ |
| **OUT** | Production loop-hardening | Bounded counters in `_attempt_connection` / `list_files`. Separate reviewed PR. | — | out of scope |
| **OUT** | GUI / real-Outlook / real-USB E2E | Class-B `gui_*` + Class-D real-COM. | — | ❌ needs display + real Outlook |

Slices 1–4 are independent of each other and can run in parallel **after** Slice 0. Slice 0 must go first — without the timeout net and the true baseline, every later coverage number is untrustworthy and the hung files can silently re-break CI.

---

## 6. Definition of done + effort

**Gate 4 is done when:**
1. Both previously-hung files run, bounded by `pytest-timeout`.
2. **0 failing desktop tests** (63 → 0: 25 deleted, 38 fixed).
3. A re-measured, honest whole-app floor with a **ratcheting `fail_under`** wired into CI (regression net).
4. **80% on the defined critical-mockable module set** (protocol/persistence/config/auth) — the real quality bar.
5. Documented + out of scope: 80%-whole-app is not achievable headless; real-Outlook/Gemini/USB E2E are manual-QA / display-equipped-CI follow-ups; production loop-hardening is a separate reviewed PR.

**"Done" is NOT** "desktop coverage = 80% whole-app." The milestone is re-scoped to "**80% on critical mockable modules + a ratcheting whole-app floor**." This is an explicit re-scope, not a miss.

**Effort (coarse):** Slices 0–4 (un-hang + all 63 green + gate plumbing) ≈ **3–4 sessions**; Slices 5–6 (critical set to 80%) ≈ **3–5 sessions** (much is branch/edge top-up — ~70 test files already exist). **Total ≈ 6–9 focused single-developer sessions**, all achievable here except the flagged GUI/COM/USB-E2E and the production-hardening PR.

---

## Appendix — verified facts (checked against the live repo)

- Active `apps/desktop/pyproject.toml` has **no `fail_under`**; `--cov-fail-under=80` removed in `c92c9993`, surviving only in stale `apps/desktop/config/pyproject.toml`.
- `pytest-timeout` **not installed**; `pytest-cov` 7.1.0 / `coverage` 7.14.1 are.
- `simple_calendar_mixin.py` **does not exist** anywhere; `async_calendar_mixin.py` imports the Outlook integration via a lazy, `try`-guarded, mockable seam.
- `ai_service.py` uses `from google import genai` (`google-genai` 2.8.0) — Family B is genuine SDK-migration mock-drift, not a network dependency.
