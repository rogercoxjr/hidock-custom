# Gate 4 Design — Restore a Meaningful Desktop Python Coverage Gate

**Scope:** `apps/desktop/` (Python).
**Status:** Approved design, **revised 2026-06-09** after an adversarial review of the first draft (the gate mechanism, production-hang handling, counts, and several contradictions were corrected — see the revision notes inline).
**Context:** Gate 4 of the "primetime" effort. The original milestone label was "desktop Python coverage 13% → 80%." This design re-scopes that to an achievable, honest bar (§4). Facts cited inline were verified against the live repo.

> **Important path fact:** the desktop modules live in **`apps/desktop/src/`** (e.g. `apps/desktop/src/hidock_device.py`); tests add `../src` to `sys.path` via `tests/conftest.py`. Every coverage `--include`/source pattern in this spec therefore targets `src/…`, not bare filenames.

---

## 1. Baseline — honest current state

Two coverage numbers are in circulation; the gap is load-bearing:

| Number | Source | What it measures |
|---|---|---|
| **~13%** | Readiness memory / original Gate-4 framing | An earlier/narrower measurement. The label the milestone was set against. |
| **~33%** | Clean assessment run | `pytest tests --cov=. -q` with the two hung files excluded — **5,587 / 17,012 statements**. |

**Reconciliation:** treat **~33% as the real measured floor** and **13% as a stale label**. Do not present 33% as a 20-point gain. The authoritative floor used to set the gate is the **single clean measurement taken in Slice 7** (after all test changes land and the two hung files are re-included); the Slice-0 number is informational/effort-sizing only.

**There is no coverage gate today.** The active `apps/desktop/pyproject.toml` has `--cov=.` + reports but **no `fail_under`** in `[tool.coverage.report]` and no `--cov-fail-under` in addopts. `--cov-fail-under=80` was removed in commit `c92c9993`; a stale copy survives only in the non-active `apps/desktop/config/pyproject.toml`. "Restore a meaningful gate" therefore means *add* one (§4).

**Test results (clean run, hung files excluded):** **63 failed · 1,207 passed · 18 skipped** (286s). Pass rate among non-skipped ≈ **95.0%**.

**Hard blockers (verified):**
- **B1 — Two test files hang the suite with no watchdog.** `test_hidock_device_file_operations.py` and `test_hidock_device_connection.py` are excluded from every run. `pytest-timeout` is **not installed** (verified: `import pytest_timeout` → `ModuleNotFoundError` in `.venv.win`), so a runaway loop hangs the whole run silently. These files exercise `hidock_device.py` (the protocol core), so excluding them suppresses coverage on the most important module — no honest whole-app number exists until they run.
- **B2 — 63 failures must be green before any gate is enforced.** A `fail_under` gate is meaningless while tests fail.
- **B3 — Two 0%-covered modules, handled differently:**
  - `oauth2_token_manager.py` — **live Class-A logic that simply lacks tests.** It is a **gap to fill** (Slice 5 / the 80% allowlist), *not* something to exclude.
  - `jensen_protocol_extensions.py` — **dead/disabled stub code.** **Exclude it** from coverage via `[tool.coverage.run] omit` so it does not skew the denominator. (These two were previously lumped together; they require opposite handling.)

**Coverage-delta note (corrected):** deleting the dead calendar tests (§2 A-a) changes app coverage by **~0** — they exercise no source today. The only action that *moves* the number is **re-including the two hung files** (adds `hidock_device.py` coverage). Do not expect the deletion itself to change the percentage.

**What cannot be verified here:** real Outlook/COM behavior, real Gemini network calls, real USB hardware. None of the 63 failures *require* those (all are mock-drift), but end-to-end correctness of those paths can only be checked as internally-consistent mocked contracts.

**Why 80%-whole-app is structurally impossible headless:** the largest files are GUI (CustomTkinter, need a display) — `gui_main_window.py` (~2,404 coverage statements, **~38% covered**) and `settings_window.py` (~938 statements, **~11% covered**) — plus real-Outlook/COM paths. Covering those to 80% needs a display server + real Outlook this CI track does not have. (Stated as per-file coverage %, not raw file-LOC, to avoid the unit-mixing in the first draft.)

---

## 2. Family A — the calendar/Outlook tests (40 failures)

Verified counts: `test_simple_calendar_mixin_coverage.py` (**26**), `test_async_calendar_mixin.py` (13), `test_outlook_calendar_service.py::test_authenticate_failure` (1) = **40**. Three sub-problems, three answers:

- **A-a — `test_simple_calendar_mixin_coverage.py` (26): the module is gone, but the feature moved.** `simple_calendar_mixin.py` exists nowhere; all 26 tests fail at in-method import (`import simple_calendar_mixin` inside each test body) and cover nothing today. **BUT** the functionality was refactored into `async_calendar_mixin.py` (`enhance_files_with_meeting_data`, `_parse_file_datetime`) and duplicated in `outlook_integration_mixin.py`. **→ Action: before deleting, audit which behaviors are NOT re-covered elsewhere** — specifically `_parse_file_datetime` invalid/missing-data → `None` and `_find_meeting_for_file` caching — and **port those edge cases into `test_async_calendar_mixin.py`**, then delete the dead file. ("Delete, covers nothing" is the right *action* but the first draft's "no surviving target" reasoning was wrong; the audit prevents silently dropping live edge-case coverage.)
- **A-b — `test_async_calendar_mixin.py` (13): harness drift, not a COM dependency.** `async_calendar_mixin.py` imports `create_simple_outlook_integration` inside a `try` and instantiates it lazily — an injectable seam. Failures are `AttributeError: ... 'mock_gui'` (a harness fixture referencing an attribute that no longer exists). **→ Fix by copying the working `MockGUI` class + `self.gui = MockGUI()` init from `test_high_impact_coverage.py`'s `TestAsyncMixin` harness (~lines 194-210; note the `TestMixin` at 169-176 is gui-less and won't fix the `mock_gui` error)** and patching the seam to a `Mock`. No real Outlook / win32com / display needed.
- **A-c — `test_outlook_calendar_service.py::test_authenticate_failure` (1): assertion drift.** `assert <Mock Account()> is None` — the failure path no longer nulls `self.account`. **→ Realign the assertion** to the current failure signal.

**Family-A decision: do NOT defer or env-gate-and-skip.** Audit+port edge cases then delete A-a, fix A-b/A-c with mocks — all achievable here. Real-Outlook E2E is a separate, explicitly out-of-scope manual-QA item.

---

## 3. The two hung files

Static analysis: both hangs are **pure-Python loop / wall-clock**, **not** USB probing — tests already patch `usb.core.find` / `_send_command` / `_receive_response`, so no real hardware is touched (consistent with the CLAUDE.md USB-safety rules; do **not** "fix" by touching a device). Root infrastructural gap: **no `pytest-timeout`** → an unbounded loop hangs the run instead of failing one test.

Recommended handling, in order:
1. **Add `pytest-timeout` to desktop dev deps; apply module-level `pytestmark = pytest.mark.timeout(20)` to both files.** (20s, not 10s — the suite already runs 286s and some mocked-protocol tests legitimately iterate; 20s fails a true hang fast without flaking a slow-but-valid test. Per-test `@pytest.mark.timeout(N)` overrides where needed.) This belongs in **Slice 0a** (the safety net, mergeable alone).
2. **`test_hidock_device_file_operations.py` — make `list_files` mocks terminate deterministically.** Use the **empty-body completion idiom that already passes in this same file** (`test_list_files_empty_response_completion`, ~lines 60-71): a finite `_receive_response` `side_effect` whose final element is `{"id": CMD_GET_FILE_LIST, "body": b""}`. **Critical:** a constant empty-body `return_value` is fine for the clean-completion case (that's exactly what the cited `test_list_files_empty_response_completion` does — an empty `CMD_GET_FILE_LIST` body triggers the completion path). It is only dangerous for a *mismatched-id* response: that hits `list_files`' `else: continue` branch *without* advancing, so a constant mismatched-id `return_value` spins forever — use a finite `side_effect` there.
3. **`test_hidock_device_connection.py` — diagnose before patching.** This file contains **no `connect()` calls** and never invokes `_receive_response`; the `_attempt_connection` flush loop is **bounded** (`flush_count < max_flush_attempts=10`) and `reset_device_state` uses `for _ in range(10)` — none of these can spin. **So the first draft's "give `ep_in.read` a terminating `USBTimeoutError`" recipe was aimed at an already-bounded loop.** First reproduce the actual stall under the new timeout marker (it may be a slow path or a collection/import issue, not an infinite loop), then apply the minimal fix. The proven `USBTimeoutError`-drain idiom (`test_hidock_device_commands.py`, patching `device.read`) is the reuse source **if** a drain loop turns out to be the culprit.
4. **`stream_file` empty-chunk path (download).** Its loop only exits when `time.time() > end_time` (`end_time = start_time + timeout_s`, default 180s). A test mocking a constant empty chunk must patch `hidock_device.time.time` with a `side_effect` whose values **exceed `start+timeout_s`** (and patch `hidock_device.time.sleep`); "finite increasing" alone is insufficient. (`hidock_device` does `import time`, so `patch("hidock_device.time.time")` works — the existing passing tests at ~lines 339/370 use exactly this.)

**The corresponding production loop-hardening is now an in-scope slice (Slice 8), NOT an unscheduled deferral** — see §4/§5. Masking a real device-hang in tests while leaving the cause unscheduled is unacceptable for "primetime."

---

## 4. Coverage-gate strategy (revised mechanism)

**A two-part gate with two *distinct, explicitly-located* mechanisms:**

**Part 1 — whole-app regression floor (a single static number).**
- Set `fail_under = N` in **`apps/desktop/pyproject.toml` → `[tool.coverage.report]`** (this is the location `coverage`/`pytest-cov` actually read; an implementer must put it there, not in a non-existent table).
- `N = floor(measured_clean_coverage) − 1` — i.e. take the integer part of the Slice-7 measured %, subtract 1 (one-point flake margin). Example: measured 41.6% → `N = 40`.
- This is a **static floor**, raised **manually** in a follow-up PR when coverage rises — there is **no automated ratchet** (nothing in this plan builds per-PR floor-bumping; do not imply it exists). Its job is purely to prevent backsliding.

**Part 2 — hard 80% *per module* on a critical-mockable allowlist (the real quality bar).**
- Enforced **per module**, not aggregate. Mechanism: a CI step that runs, for **each** allowlist module individually:
  `coverage report --include=src/<module>.py --fail-under=80`
  (a single-file `--include` makes the aggregate == that one file, so each module is checked on its own — a 0%-covered module cannot hide behind well-covered siblings, which an aggregate `--include=<whole set>` would allow). Implement as a small shell/Python loop over the allowlist; fail the step if any module is < 80%. **Verified empirically:** running this loop against live coverage data, `oauth2_pkce.py` at 0% exits non-zero while `file_operations_manager.py` at 97% passes — per-module enforcement works.
- **The `.coverage` data MUST come from a `pytest --cov` run** (as Slice 7 does), not `coverage run --source=src`: under the latter, modules already imported by `tests/conftest.py` record a false 0% because the tracer attaches after import.
- **Allowlist (all under `src/`, all Class-A / display-free / hardware-free):** `file_operations_manager.py`, `storage_management.py`, `audio_metadata_db.py`, `device_interface.py`, `hta_converter.py`, `calendar_cache_manager.py`, `calendar_filter_engine.py`, `gemini_models.py`, `oauth2_pkce.py`, `oauth2_token_manager.py`, `config_and_logger.py`.
- **`hidock_device.py` is deliberately NOT in the per-module 80% allowlist.** It is a single ~2,750-line file fused with USB hardware; `coverage --include` is file-granular, so you cannot gate "just the pure protocol helpers." Instead: **add unit tests for its pure helpers** (`_build_packet` packet assembly; the inbound 24-bit body-length parse in `_receive_response`) in Slice 6 — these raise the **whole-app floor (Part 1)** but the file is not held to file-level 80%. (The first draft listed a non-existent `checksum` helper and tried to gate sub-file regions — removed.)

Rejected alternatives: "hold-until-80%-whole-app" blocks forever on display/COM code; an aggregate `--include` check gives false assurance (a 0% critical module passes). The per-module loop + a static floor is the honest, enforceable combination.

---

## 5. Ordered work breakdown (subagent-sized slices)

✅ = achievable here (no display/Outlook/USB hardware). **Inner-loop feedback rule for every slice:** validate a fix by running only the affected file *without* coverage (e.g. `pytest tests/test_async_calendar_mixin.py -q`); reserve the full `--cov` whole-suite run (~286s) for milestone checkpoints (end of Slice 0b for the informational baseline, and Slice 7 for the authoritative gate measurement). Do **not** run a full coverage pass per slice.

| # | Slice | Scope | Effort | Here? |
|---|---|---|---|---|
| **0a ⭐ FIRST** | Timeout safety net | Add `pytest-timeout` (dev dep); module-level `timeout(20)` marker on both hung files. Mergeable alone — converts any hang into a fast failure. | ~¼ session | ✅ |
| **0b** | Un-hang the 2 files + informational baseline | Deterministic mocks per §3 (finite `side_effect`s; diagnose the connection file before patching); re-include both files; run one full `--cov` pass for an *informational* baseline (not the gate number). | ~1 session | ✅ |
| **1** | Audit + delete dead calendar tests (A-a) | Audit which `simple_calendar` edge cases aren't re-covered (§2 A-a), port them into `test_async_calendar_mixin.py`, then delete `test_simple_calendar_mixin_coverage.py` (26 tests). | ~½–1 session | ✅ |
| **2** | Fix Family A live tests | `test_async_calendar_mixin.py` (13, copy `MockGUI`+init from `test_high_impact_coverage.py`, mock the lazy COM seam) + `test_outlook_calendar_service.py` (1, realign assertion). | ~1 session | ✅ (mock-only) |
| **3** | Fix Family B AI/transcription mock-drift | `test_ai_service.py` (7), `test_ai_service_focused.py` (1), `test_transcription_module.py` (14) — **22 total, verified**. Root cause: migrated to `from google import genai` (`google-genai` 2.8.0); tests still mock the old `genai.configure()`. Realign mocks to the new SDK. | ~1 session | ✅ (no network) |
| **4** | Fix the 1 connection-recovery test | `test_connection_recovery_integration.py::test_connection_recovery_after_error` — preserve the existing `device_test_*` harness + the conftest-documented no-libusb soft-skip contract (do not rewrite against a fresh inline mock). | ~¼ session | ✅ |
| **5** | New/extended Class-A coverage | Tests for `oauth2_pkce.py`, `oauth2_token_manager.py`, `gemini_models.py`, `calendar_filter_engine.py`, `audio_metadata_db.py` (largely untested) and **extend** the existing partial tests for `calendar_cache_manager.py` (`test_high_impact_coverage.py:120`). **Order by absolute missing-statement count (highest first)** for fastest floor movement; re-verify per module before writing from scratch. | ~1–2 sessions | ✅ |
| **6** | Branch/edge top-up to the 80% per-module bar | Push every Part-2 allowlist module to ≥80% (incl. `file_operations_manager.py`, `storage_management.py`, `device_interface.py`, `hta_converter.py`) and add `hidock_device.py` pure-helper tests (`_build_packet`, 24-bit parse) toward the floor. (Slices 5–6 share the same success criterion — the §4 Part-2 check — and may be executed as one continuous effort sequenced by module.) | ~2–3 sessions | ✅ |
| **7** | Install + measure the gate | One authoritative clean `--cov` run → set Part-1 `fail_under = floor−1` in `[tool.coverage.report]`; add the Part-2 per-module 80% loop; wire both into CI. Promote the duplicated connected-`HiDockJensen` fixture into `conftest.py` while here (it is copy-pasted ~20×; consolidating prevents the next mock-drift wave). | ~½ session | ✅ |
| **8** | **Production loop-hardening (in-scope, reviewed prod change)** | Bound the unbounded mismatch loops the tests mock around: `list_files`' `else: continue` (~hidock_device.py:1999) and the parallel-path helper **`_receive_all_chunks_for_parallel`'s `else: continue` (~:1634 — `list_files_parallel` itself just delegates and has no loop)** — add a `consecutive_mismatch` cap → fail with status, and **reset the counter on each valid `CMD_GET_FILE_LIST` chunk** (mirroring the existing `consecutive_timeouts` reset) so a long valid listing with stray interleaved packets isn't falsely aborted. `stream_file`'s empty-chunk path (~:2399) is **already wall-clock-bounded (180s)** — not infinite; only optionally tighten it, with a cap generous enough not to abort a slow-but-valid large transfer. **TDD:** write the termination test first (hangs → fails under the timeout marker), then add the bound. `_attempt_connection` is already bounded — do **not** touch it. | ~1.5–2 sessions | ✅ (mock-tested; reviewed) |
| **OUT** | GUI / real-Outlook / real-USB E2E | Class-B `gui_*` + Class-D real-COM verification. | — | ❌ needs display + real Outlook |

Slices 1–4 are independent of each other and can run after Slice 0b; **coverage is measured once after they all land**, not per parallel branch. Slice 0a must go first.

---

## 6. Definition of done + effort

**Gate 4 is done when:**
1. Both previously-hung files run, bounded by `pytest-timeout`.
2. **0 failing desktop tests** — **63 → 0: 26 deleted (A-a), 37 fixed** (13 A-b + 1 A-c + 22 Family B + 1 recovery — all verified).
3. Part-1 static `fail_under` (= floor−1) wired into CI as a regression net.
4. Part-2 **per-module 80%** on the §4 allowlist (enforced per module, not aggregate — an honest claim).
5. **Production mismatch-loops bounded (Slice 8):** `list_files` and the parallel-path helper `_receive_all_chunks_for_parallel` can no longer spin on stuck/mismatched packets (counter reset on valid chunks); `stream_file` is already 180s wall-clock-bounded. A primetime requirement, not a deferral.
6. **Named high-risk behavioral assertions exist** (coverage % is a proxy; these assert the behaviors that matter): `list_files` terminates on a stuck non-matching packet (after Slice 8's cap); `stream_file` terminates within its wall-clock bound on repeated empty chunks; file delete confirms before removing (**already covered** by `test_file_operations_gui.py::test_delete_from_device_with_confirmation` — preserve it, don't rebuild). These are explicit done-criteria, not implied by a coverage number.
7. Documented + out of scope: 80%-whole-app is not achievable headless; real-Outlook/Gemini/USB E2E are manual-QA / display-equipped-CI follow-ups.

**"Done" is NOT** "desktop coverage = 80% whole-app." The milestone is re-scoped to "**80% per critical mockable module + a static whole-app regression floor + bounded production loops + named behavioral assertions**." This is an explicit re-scope, not a miss.

**Effort (coarse):** Slices 0a–4 + 8 (un-hang + all 63 green + bound the prod loops) ≈ **4.5–6 sessions** (Slice 8's TDD'd loop-hardening across the 2,750-line protocol core is the riskiest single item); Slices 5–7 (allowlist to per-module 80% + gate plumbing) ≈ **3–5 sessions** (much is branch/edge top-up — ~74 test files already exist). **Total ≈ 8–11 focused single-developer sessions**, all achievable here except the flagged GUI/COM/USB-E2E items.

---

## Appendix — verified facts (checked against the live repo)

- Active `apps/desktop/pyproject.toml` has **no `fail_under`**; `--cov-fail-under=80` removed in `c92c9993`, surviving only in stale `apps/desktop/config/pyproject.toml`.
- `pytest-timeout` is **not installed** (`import pytest_timeout` → `ModuleNotFoundError` in `.venv.win`); `pytest-cov` 7.1.0 / `coverage` 7.14.1 are.
- The desktop modules live under **`apps/desktop/src/`**; tests resolve them via `tests/conftest.py` adding `../src` to `sys.path`. Coverage records them as `src/<module>.py` — `--include` patterns must use that path.
- `test_simple_calendar_mixin_coverage.py` collects **26** tests (all fail); `simple_calendar_mixin.py` does not exist; the feature moved into `async_calendar_mixin.py` / `outlook_integration_mixin.py`.
- `async_calendar_mixin.py` imports the Outlook integration via a lazy, `try`-guarded, mockable seam.
- `ai_service.py` uses `from google import genai` (`google-genai` 2.8.0) — Family B is SDK-migration mock-drift, not a network dependency.
- `_attempt_connection` is **bounded** (retry ≤ 3, flush ≤ 10); the genuinely unbounded loops are `list_files`/`list_files_parallel` `else: continue` and `stream_file`'s empty-chunk path. `_build_packet` packs a plain big-endian length (no `checksum` function exists); the 24-bit body-length parse is inline in `_receive_response`.
- `apps/desktop/tests/` contains ~74 test files.
