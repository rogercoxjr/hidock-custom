# Gate 4: Desktop Python Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a meaningful, honest desktop Python coverage gate by un-hanging the two excluded device-test files, turning all 63 (+3 newly-surfaced) failing tests green, raising 11 critical mockable modules to per-module ≥80%, wiring a two-part CI gate (static whole-app floor + per-module 80% loop), and bounding the two unbounded production mismatch-loops in `hidock_device.py`.

**Architecture:** All work is in `apps/desktop/`; modules live in `apps/desktop/src/` and tests in `apps/desktop/tests/` (the test suite adds `../src` to `sys.path` via `tests/conftest.py`, so coverage records paths as `src/<module>.py`). The gate is two distinct mechanisms: Part 1 is a single static `fail_under = floor−1` in `[tool.coverage.report]` (backslide net); Part 2 is a per-module loop running `coverage report --include=src/<mod>.py --fail-under=80` over an 11-module allowlist, fed by data from a `pytest --cov` run. Every device test mocks `usb.core.find` / `_send_command` / `_receive_response` — no real hardware is ever touched (see USB-safety section of `CLAUDE.md`).

**Tech Stack:** pytest, pytest-cov, pytest-timeout, coverage.py, unittest.mock; Python 3 / .venv.win

---

## Environment / invariants (read before every task)

- **Python:** `apps/desktop/.venv.win/Scripts/python.exe`. Run pytest as `cd apps/desktop && ./.venv.win/Scripts/python.exe -m pytest ...` (Git Bash forward-slash paths).
- **Inner-loop rule:** validate a fix by running only the affected file *without* coverage: append `--no-cov -p no:cacheprovider -p no:randomly -q`. Reserve the full `--cov` whole-suite run (~286s) for the two milestone checkpoints (end of Task 0b informational baseline; Task 7 authoritative gate measurement). Do **NOT** run a full `--cov` pass per slice.
- **⛔ USB safety:** never run `tests/test_hidock_device_file_operations.py` or `tests/test_hidock_device_connection.py` against real hardware. They are mock-only. They are currently excluded from runs because one hangs (file-ops). Do not "fix" any hang by touching a device.
- **Branch:** all implementation runs on a **new branch off `main`** (`gate4-desktop-coverage`), separate from the current `fix/electron-green-gate` branch. Create it in Task 0a step 1.
- **`pytest-timeout` is NOT installed yet** (Task 0a adds it). `pytest-cov` 7.1.0 / `coverage` 7.14.1 are installed.

---

## File Structure (what each slice touches)

| Slice | Creates | Modifies |
|---|---|---|
| 0a | — | `apps/desktop/pyproject.toml` (dev dep), `tests/test_hidock_device_file_operations.py` + `tests/test_hidock_device_connection.py` (module-level `pytestmark`) |
| 0b | — | `tests/test_hidock_device_file_operations.py` (deterministic mocks), `tests/test_hidock_device_connection.py` (3 assertion realignments) |
| 1 | — | `tests/test_async_calendar_mixin.py` (port edge cases), delete `tests/test_simple_calendar_mixin_coverage.py` |
| 2 | — | `tests/test_async_calendar_mixin.py` (realign to live API), `tests/test_outlook_calendar_service.py` (1 assertion) |
| 3 | — | `tests/test_ai_service.py`, `tests/test_ai_service_focused.py`, `tests/test_transcription_module.py` (new-SDK mock realignment) |
| 4 | — | `tests/test_connection_recovery_integration.py` (soft-skip on "not found") |
| 5 | `tests/test_oauth2_token_manager.py`, `tests/test_gemini_models.py`, `tests/test_oauth2_pkce.py`, `tests/test_calendar_filter_engine.py`, `tests/test_audio_metadata_db_gate4.py` | `tests/test_high_impact_coverage.py` (extend cache-manager) |
| 6 | (top-up test files for allowlist modules) | adds `_build_packet` / 24-bit-parse tests (e.g. `tests/test_hidock_device_helpers_gate4.py`) |
| 7 | — | `apps/desktop/pyproject.toml` (`fail_under` + omit), CI workflow, `tests/conftest.py` (shared connected-Jensen fixture) |
| 8 | `tests/test_hidock_device_loop_bounds.py` | `apps/desktop/src/hidock_device.py` (two bounded counters) |

---

### Task 0a: Timeout safety net (mergeable alone)

Converts any hang into a fast per-test failure. Spec §5 slice 0a / §3.1.

**Files:**
- Modify: `apps/desktop/pyproject.toml`
- Modify (Test): `apps/desktop/tests/test_hidock_device_file_operations.py`, `apps/desktop/tests/test_hidock_device_connection.py`

- [ ] **Create branch.** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git checkout main && git checkout -b gate4-desktop-coverage
  ```
  Expected: `Switched to a new branch 'gate4-desktop-coverage'`.
- [ ] **Add `pytest-timeout` to the dev deps.** In `apps/desktop/pyproject.toml`, edit the `[project.optional-dependencies]` `dev` list. Change:
  ```toml
      "pytest-asyncio>=0.21.0",
      "pytest-xdist>=3.0.0",
  ```
  to:
  ```toml
      "pytest-asyncio>=0.21.0",
      "pytest-xdist>=3.0.0",
      "pytest-timeout>=2.1.0",
  ```
- [ ] **Install it into `.venv.win`.** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pip install "pytest-timeout>=2.1.0"
  ```
  Then verify:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -c "import pytest_timeout; print(pytest_timeout.__version__)"
  ```
  Expected: a version string (e.g. `2.3.1`), no `ModuleNotFoundError`.
- [ ] **Add module-level timeout marker to the file-ops file.** At the top of `apps/desktop/tests/test_hidock_device_file_operations.py`, immediately after the imports block (after `from hidock_device import HiDockJensen`), insert:
  ```python
  # Gate 4 (Task 0a): a runaway protocol loop must fail one test fast, not hang
  # the whole suite. 20s is generous vs. the ~286s full suite — a true hang
  # blows past it, a slow-but-valid mocked iteration does not.
  pytestmark = pytest.mark.timeout(20)
  ```
- [ ] **Add the same marker to the connection file.** At the top of `apps/desktop/tests/test_hidock_device_connection.py`, after its import block, insert the identical `pytestmark = pytest.mark.timeout(20)` line (add `import pytest` if not already imported — it is).
- [ ] **Prove the marker fires (the file-ops file now FAILS fast instead of hanging).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest "tests/test_hidock_device_file_operations.py::TestHiDockJensenFileListOperations::test_list_files_with_header_and_files" --no-cov -p no:cacheprovider -p no:randomly -q
  ```
  Expected: the test FAILS with `Failed: Timeout >20.0s` (NOT a wall-clock hang). This is the proof the safety net works; the test is fixed in Task 0b.
- [ ] **Commit.**
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git add apps/desktop/pyproject.toml apps/desktop/tests/test_hidock_device_file_operations.py apps/desktop/tests/test_hidock_device_connection.py && git commit -m "test(desktop): Gate4 0a — add pytest-timeout dev dep + 20s module timeout on the two device test files

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 0b: Un-hang the two files + informational baseline

Make the file-ops mocks terminate deterministically; realign the 3 assertion failures the connection file surfaces once it runs; take one informational `--cov` baseline. Spec §3.2/§3.3, §5 slice 0b.

> **Verified facts (from live runs):** Only `test_list_files_with_header_and_files` actually hangs (constant `return_value` of a valid non-empty chunk never trips the completion estimate). The connection file does **NOT** hang — it completes in ~0.7s with **3 plain assertion failures** (error-string drift). This is milder than the spec's "diagnose the stall" wording; record it.

**Files:**
- Modify (Test): `apps/desktop/tests/test_hidock_device_file_operations.py`, `apps/desktop/tests/test_hidock_device_connection.py`

- [ ] **Confirm the hang location (failing run).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest "tests/test_hidock_device_file_operations.py::TestHiDockJensenFileListOperations::test_list_files_with_header_and_files" --no-cov -p no:cacheprovider -p no:randomly -q
  ```
  Expected: `Failed: Timeout >20.0s` (carried over from Task 0a).
- [ ] **Make `test_list_files_with_header_and_files` terminate via a finite `side_effect` ending in an empty body.** In `apps/desktop/tests/test_hidock_device_file_operations.py`, find the body of `test_list_files_with_header_and_files` and replace the constant return:
  ```python
                  mock_receive.return_value = {"id": CMD_GET_FILE_LIST, "sequence": 1, "body": bytes(file_data)}
  ```
  with a two-element finite sequence whose final element is the empty-body completion sentinel (the idiom proven by `test_list_files_empty_response_completion` at lines 60-71):
  ```python
                  # Gate 4 (Task 0b): the prior constant return_value spun the
                  # list_files accumulation loop forever (the completion estimate
                  # never tripped). A finite side_effect ending in an empty
                  # CMD_GET_FILE_LIST body terminates deterministically via the
                  # empty-body completion path (see test_list_files_empty_response_completion).
                  mock_receive.side_effect = [
                      {"id": CMD_GET_FILE_LIST, "sequence": 1, "body": bytes(file_data)},
                      {"id": CMD_GET_FILE_LIST, "sequence": 1, "body": b""},
                  ]
  ```
- [ ] **Run the now-fixed test (PASS).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest "tests/test_hidock_device_file_operations.py::TestHiDockJensenFileListOperations::test_list_files_with_header_and_files" --no-cov -p no:cacheprovider -p no:randomly -q
  ```
  Expected: `1 passed` (asserts 2 files parsed; the empty body completes the list).
- [ ] **Run the whole file-ops file (must complete, no hang).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_hidock_device_file_operations.py --no-cov -p no:cacheprovider -p no:randomly -q
  ```
  Expected: it finishes (e.g. `58 passed`) within seconds — no `Timeout` failures. If any other test reports `Failed: Timeout >20.0s`, apply the same finite-`side_effect`-ending-in-empty-body idiom to it.
- [ ] **Commit the file-ops un-hang.**
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git add apps/desktop/tests/test_hidock_device_file_operations.py && git commit -m "test(desktop): Gate4 0b — un-hang list_files test via finite empty-body side_effect

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```
- [ ] **See the 3 connection-file assertion failures.** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_hidock_device_connection.py --no-cov -p no:cacheprovider -p no:randomly -q
  ```
  Expected: `3 failed, 21 passed` — failures are `test_attempt_connection_set_configuration_resource_busy`, `test_attempt_connection_claim_interface_busy`, `test_attempt_connection_exception_handling`, all `AssertionError: assert 'Device is busy' in '...'`.
- [ ] **Realign `test_attempt_connection_set_configuration_resource_busy`.** The live error string is `'Device busy - close other applications and try again'`. In `apps/desktop/tests/test_hidock_device_connection.py`, change:
  ```python
          assert "Device is busy" in error
  ```
  in `test_attempt_connection_set_configuration_resource_busy` to:
  ```python
          assert "Device busy" in error
  ```
- [ ] **Realign `test_attempt_connection_claim_interface_busy`.** Its live error string is `'Device is currently in use by another application...'`. In that test, change `assert "Device is busy" in error` to:
  ```python
          assert "currently in use" in error
  ```
- [ ] **Realign the busy assertion inside `test_attempt_connection_exception_handling`.** This test has a final EBUSY block (errno 16). Read its tail; the `assert "Device is busy" in error` after the errno-16 case becomes:
  ```python
          assert "busy" in error.lower()
  ```
  (matches whichever busy phrasing the exception path now emits; the lowercased substring is robust to either wording).
- [ ] **Run the connection file (PASS).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_hidock_device_connection.py --no-cov -p no:cacheprovider -p no:randomly -q
  ```
  Expected: `24 passed`.
- [ ] **Commit the connection-file realignment.**
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git add apps/desktop/tests/test_hidock_device_connection.py && git commit -m "test(desktop): Gate4 0b — realign 3 _attempt_connection busy-error assertions to live strings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```
- [ ] **Take the INFORMATIONAL baseline (milestone full `--cov` run #1).** Both device files now run, so this is the first honest whole-app number. Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests --cov=. --cov-report=term-missing -p no:randomly -q 2>&1 | tail -20
  ```
  Expected: a `TOTAL ... NN%` line. Record this % in the PR description as the **informational** baseline (NOT the gate number — the gate number is measured in Task 7 after all test fixes land). Do not set `fail_under` yet.

---

### Task 1: Audit + delete the dead `simple_calendar` tests (Family A-a, 26 tests)

`simple_calendar_mixin.py` does not exist; all 26 tests in `test_simple_calendar_mixin_coverage.py` fail at in-method `from simple_calendar_mixin import ...` and cover zero source. Before deleting, port the two edge-case behaviors not re-covered elsewhere into `test_async_calendar_mixin.py` (the feature moved to `async_calendar_mixin.AsyncCalendarMixin`). Spec §2 A-a.

> **Verified facts:** `async_calendar_mixin._parse_file_datetime` uses the device format `"%Y/%m/%d %H:%M:%S"` (slashes) and returns `None` on missing/invalid data. There is **no `_find_meeting_for_file`** on the live mixin (that method did not survive the refactor — the meeting-matching path is now `_enhance_single_file_with_calendar_data` / `_find_best_meeting_match`). So only the `_parse_file_datetime` edge cases are portable as-is; the cache-behavior edge case has no live target and is dropped (documented in the deletion commit).

**Files:**
- Modify (Test): `apps/desktop/tests/test_async_calendar_mixin.py`
- Delete (Test): `apps/desktop/tests/test_simple_calendar_mixin_coverage.py`

- [ ] **Confirm the dead file fails wholesale.** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_simple_calendar_mixin_coverage.py --no-cov -p no:cacheprovider -p no:randomly -q 2>&1 | tail -5
  ```
  Expected: `26 failed` (every test errors on `import simple_calendar_mixin`).
- [ ] **Add the ported `_parse_file_datetime` edge-case test to `test_async_calendar_mixin.py`** (write it FIRST against the live API; it should PASS immediately because the live method already behaves this way — this is coverage-porting, not bugfixing). Append to `TestAsyncCalendarMixin` (after `test_calendar_status_before_initialization`):
  ```python
      def test_parse_file_datetime_edge_cases_ported(self):
          """Ported from the deleted simple_calendar tests (Gate 4 Task 1).

          Asserts the surviving _parse_file_datetime edge behavior on
          async_calendar_mixin.AsyncCalendarMixin: a datetime 'time' field is
          returned as-is; device 'YYYY/MM/DD HH:MM:SS' strings parse; missing
          and malformed inputs return None.
          """
          from async_calendar_mixin import AsyncCalendarMixin

          class TestMixin(AsyncCalendarMixin):
              def __init__(self):
                  self._calendar_integration = None

          mixin = TestMixin()

          # 1. datetime 'time' field returned unchanged
          ts = datetime(2023, 1, 15, 10, 30, 0)
          self.assertEqual(mixin._parse_file_datetime({"time": ts}), ts)

          # 2. device createDate/createTime strings (slash format) parse
          parsed = mixin._parse_file_datetime({"createDate": "2023/01/15", "createTime": "10:30:00"})
          self.assertEqual(parsed, datetime(2023, 1, 15, 10, 30, 0))

          # 3. missing datetime data -> None
          self.assertIsNone(mixin._parse_file_datetime({"name": "test.wav"}))

          # 4. malformed date string -> None
          self.assertIsNone(mixin._parse_file_datetime({"createDate": "invalid-date", "createTime": "10:30:00"}))
  ```
- [ ] **Run the ported test (PASS).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest "tests/test_async_calendar_mixin.py::TestAsyncCalendarMixin::test_parse_file_datetime_edge_cases_ported" --no-cov -p no:cacheprovider -p no:randomly -q
  ```
  Expected: `1 passed`. (`datetime` is already imported at the top of this test file.)
- [ ] **Commit the ported edge cases.**
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git add apps/desktop/tests/test_async_calendar_mixin.py && git commit -m "test(desktop): Gate4 1 — port _parse_file_datetime edge cases from dead simple_calendar tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```
- [ ] **Delete the dead file.** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git rm apps/desktop/tests/test_simple_calendar_mixin_coverage.py
  ```
- [ ] **Confirm collection no longer references the deleted module.** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_async_calendar_mixin.py --no-cov -p no:cacheprovider -p no:randomly -q --collect-only 2>&1 | tail -3
  ```
  Expected: collection succeeds (no `simple_calendar_mixin` import error anywhere).
- [ ] **Commit the deletion.**
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git commit -m "test(desktop): Gate4 1 — delete dead test_simple_calendar_mixin_coverage.py (26 tests, module removed in 5a3a9c9d refactor; portable edge cases moved to test_async_calendar_mixin.py; no live _find_meeting_for_file target for the cache-behavior case)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 2: Fix Family A live tests (13 async-mixin + 1 outlook)

> **Verified API discrepancy (record in report):** the spec frames the 13 `test_async_calendar_mixin.py` failures as "copy the `MockGUI` harness + fix the `mock_gui` AttributeError." Two independent root causes confirmed by running the file (`13 failed, 1 passed`):
> 1. **`mock_gui` AttributeError (12 tests):** each nested `class TestMixin: def __init__(self): self.gui = self.mock_gui` references `self.mock_gui` on the *TestMixin* instance, which has no such attribute (it lives on the `TestCase`). Capturing the test-case's mock in a closure local fixes it.
> 2. **Deleted-API references:** the current `AsyncCalendarMixin` has **no** `_initialize_async_calendar`, `_schedule_async_init`, `_calendar_available`, `_calendar_status`, or module-level `CALENDAR_AVAILABLE`. Tests asserting against those (e.g. `test_async_calendar_initialization_success/_failure/_exception`, `test_schedule_async_init_method`, `test_full_integration_flow`) must be realigned to the live API (`_ensure_async_calendar_initialized`, `_initialize_async_calendar_components`, `get_calendar_status_text_for_gui`, `SIMPLE_CALENDAR_AVAILABLE`) or removed. So Slice 2 is a real realignment, not just a harness copy.

**Files:**
- Modify (Test): `apps/desktop/tests/test_async_calendar_mixin.py`, `apps/desktop/tests/test_outlook_calendar_service.py`

- [ ] **Reproduce the 13 failures.** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_async_calendar_mixin.py --no-cov -p no:cacheprovider -p no:randomly -q 2>&1 | tail -20
  ```
  Expected: `13 failed, 1 passed` plus the new ported test from Task 1; note the `'TestMixin' object has no attribute 'mock_gui'` and `does not have the attribute 'CALENDAR_AVAILABLE'` messages.
- [ ] **Fix the `mock_gui` closure bug across the file (12 tests).** In every nested `TestMixin`/`TestAsyncMixin` `__init__` that does `self.gui = self.mock_gui`, replace `self.mock_gui` with a closure local. The clean pattern at the start of each affected test:
  ```python
          mock_gui = self.mock_gui  # closure-capture; nested TestMixin can't see TestCase attrs
  ```
  and inside the nested class:
  ```python
              def __init__(self):
                  self.gui = mock_gui
  ```
  Apply to `test_async_calendar_mixin_initialization`, `test_ensure_async_calendar_initialized`, `test_calendar_status_text_for_gui`, `test_compatibility_wrapper_methods`, `test_enhance_files_with_meeting_data_empty`, `test_enhance_files_with_meeting_data_no_calendar`, `test_calendar_status_before_initialization`, `test_concurrent_initialization_protection` (the ones that only touch live methods).
- [ ] **Run the closure-fixed subset (PASS).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest "tests/test_async_calendar_mixin.py::TestAsyncCalendarMixin::test_enhance_files_with_meeting_data_no_calendar" "tests/test_async_calendar_mixin.py::TestAsyncCalendarMixin::test_compatibility_wrapper_methods" --no-cov -p no:cacheprovider -p no:randomly -q
  ```
  Expected: `2 passed`.
- [ ] **Realign the deleted-API initialization tests.** `_initialize_async_calendar` does not exist; the live sync initializer is `_initialize_async_calendar_components`, gated on module-level `SIMPLE_CALENDAR_AVAILABLE` (not `CALENDAR_AVAILABLE`), and it creates the integration via `create_simple_outlook_integration()`. Replace `test_async_calendar_initialization_success` with a realignment against the live seam:
  ```python
      @patch("async_calendar_mixin.SIMPLE_CALENDAR_AVAILABLE", True)
      @patch("async_calendar_mixin.create_simple_outlook_integration")
      def test_initialize_components_success(self, mock_create_integration):
          """Realigned (Gate 4 Task 2): live API is _initialize_async_calendar_components
          gated on SIMPLE_CALENDAR_AVAILABLE, not the removed _initialize_async_calendar."""
          from async_calendar_mixin import AsyncCalendarMixin

          mock_integration = Mock()
          mock_integration.is_available.return_value = True
          mock_create_integration.return_value = mock_integration

          mixin = AsyncCalendarMixin()
          mixin._calendar_cache_manager = None
          mixin._calendar_integration = None
          with patch.object(mixin, "_calendar_worker_loop"):
              mixin._initialize_async_calendar_components()

          self.assertIsNotNone(mixin._calendar_integration)
          mock_create_integration.assert_called_once()
  ```
  Apply the analogous realignment to `test_async_calendar_initialization_failure` (assert the integration is still set but `is_available()` is False) and delete `test_async_calendar_initialization_exception`, `test_schedule_async_init_method`, and `TestAsyncCalendarMixinIntegration.test_full_integration_flow` (they assert behaviors — `_calendar_status`, `_schedule_async_init`, `CALENDAR_AVAILABLE` — that no longer exist; document in the commit). When `_initialize_async_calendar_components` raises (the `except Exception` branch at src line 74), it logs and returns — assert no raise rather than a status string.
- [ ] **Run the full async-mixin file (PASS).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_async_calendar_mixin.py --no-cov -p no:cacheprovider -p no:randomly -q 2>&1 | tail -5
  ```
  Expected: all collected tests pass (`N passed`), 0 failed.
- [ ] **Commit the async-mixin fix.**
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git add apps/desktop/tests/test_async_calendar_mixin.py && git commit -m "test(desktop): Gate4 2 — fix mock_gui closure bug + realign async calendar tests to live API (no _initialize_async_calendar/CALENDAR_AVAILABLE)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```
- [ ] **Reproduce the outlook A-c failure.** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest "tests/test_outlook_calendar_service.py::TestOutlookCalendarService::test_authenticate_failure" -m "" --no-cov -p no:cacheprovider -p no:randomly -q 2>&1 | tail -6
  ```
  Expected: `AssertionError: assert <Mock name='Account()' ...> is None` (`outlook_service.account` is no longer nulled on failure).
- [ ] **Realign the assertion.** In `apps/desktop/tests/test_outlook_calendar_service.py`, in `test_authenticate_failure`, the failure path (src `authenticate` lines 161-174) sets `self.account = Account(...)` then returns `False` *without* nulling it. The valid failure signal is `result is False` + `_is_authenticated is False`. Delete the stale line:
  ```python
          assert outlook_service.account is None
  ```
  Leave `assert result is False` and `assert outlook_service._is_authenticated is False` (both pass).
- [ ] **Run the outlook test (PASS).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest "tests/test_outlook_calendar_service.py::TestOutlookCalendarService::test_authenticate_failure" -m "" --no-cov -p no:cacheprovider -p no:randomly -q
  ```
  Expected: `1 passed`.
- [ ] **Commit the outlook fix.**
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git add apps/desktop/tests/test_outlook_calendar_service.py && git commit -m "test(desktop): Gate4 2 — drop stale account-is-None assertion in test_authenticate_failure (failure path no longer nulls self.account)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 3: Fix Family B AI/transcription mock-drift (22 tests)

Root cause: the code migrated to `from google import genai` (`google-genai`). New contract: `genai.Client(api_key=...)`; `client.models.generate_content(model=..., contents=...)` returning an object with `.text`; for `transcription_module._call_gemini_api`, `response.to_dict()`. Tests still mock the old `genai.configure()` / `genai.GenerativeModel(...)`. Spec §3 / §5 slice 3.

> **Verified contract anchors:** `ai_service.GeminiProvider.__init__` → `self.client = genai.Client(api_key=api_key)` (src:96); `validate_api_key` → `self.client.models.generate_content(model=model_name, contents="Test validation message")` (src:120); `transcribe_audio` uploads via `self.client.files.upload(file=...)` then `self.client.models.generate_content(model=..., contents=[prompt, audio_file])` and deletes via `self.client.files.delete(name=...)` (src:305,330,336); `analyze_text` → `self.client.models.generate_content(model=..., contents=prompt)` (src:388). `transcription_module._call_gemini_api` → `genai.Client(api_key=...)` then `client.models.generate_content(model=..., contents=..., config=...)` → `response.to_dict()` (src:90-96). `process_audio_file_for_insights` now uses the **combined** path: `ai_service.get_provider("gemini").transcribe_and_analyze_audio(path, language)` (src:361-370), NOT the old `transcribe_audio`+`extract_meeting_insights` two-step.

**Files:**
- Modify (Test): `apps/desktop/tests/test_ai_service.py`, `apps/desktop/tests/test_ai_service_focused.py`, `apps/desktop/tests/test_transcription_module.py`

- [ ] **Reproduce the 22 failures.** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_ai_service.py tests/test_ai_service_focused.py tests/test_transcription_module.py --no-cov -p no:cacheprovider -p no:randomly -q 2>&1 | tail -25
  ```
  Expected: `22 failed, 96 passed`.
- [ ] **Fix `test_gemini_provider_initialization_success`.** In `test_ai_service.py`, replace:
  ```python
          mock_genai.configure.assert_called_once_with(api_key=self.test_api_key)
  ```
  with the new-SDK constructor assertion:
  ```python
          mock_genai.Client.assert_called_once_with(api_key=self.test_api_key)
  ```
- [ ] **Fix `test_gemini_validate_api_key_success`.** Replace the old GenerativeModel mock:
  ```python
          mock_model = Mock()
          mock_model.generate_content.return_value = Mock(text="test response")
          mock_genai.GenerativeModel.return_value = mock_model

          provider = GeminiProvider(self.test_api_key)

          assert provider.validate_api_key() is True
          mock_model.generate_content.assert_called_once_with("Test validation message")
  ```
  with the new Client.models contract:
  ```python
          mock_client = mock_genai.Client.return_value
          mock_client.models.generate_content.return_value = Mock(text="test response")

          provider = GeminiProvider(self.test_api_key)

          assert provider.validate_api_key() is True
          mock_client.models.generate_content.assert_called_once_with(
              model="gemini-2.0-flash-exp", contents="Test validation message"
          )
  ```
  (`self.test_config` is `{"model": "gemini-pro"}` in `setup_method`, but `validate_api_key` normalizes unknown names back to the default `gemini-2.0-flash-exp` per src:114-116, and `GeminiProvider(self.test_api_key)` here is constructed without config, so the model is the default.)
- [ ] **Fix `test_gemini_validate_api_key_failure`.** Replace the `mock_genai.GenerativeModel.return_value = mock_model` block with:
  ```python
          mock_client = mock_genai.Client.return_value
          mock_client.models.generate_content.side_effect = Exception("Invalid API key")

          provider = GeminiProvider(self.test_api_key)

          assert provider.validate_api_key() is False
  ```
- [ ] **Fix `test_gemini_transcribe_audio_success`.** The new path uploads then generates; the old `open`/`base64` mocks are irrelevant. Replace the decorators+body so it mocks the upload + generate + delete chain:
  ```python
      @patch("ai_service.GEMINI_AVAILABLE", True)
      @patch("ai_service.genai")
      def test_gemini_transcribe_audio_success(self, mock_genai):
          """Test successful audio transcription with the google-genai Client SDK."""
          mock_client = mock_genai.Client.return_value
          mock_uploaded = Mock(uri="files/abc", name="files/abc")
          mock_client.files.upload.return_value = mock_uploaded
          mock_client.models.generate_content.return_value = Mock(
              text="[00:00] Speaker 1: Transcribed text from audio"
          )

          provider = GeminiProvider("test_key")
          result = provider.transcribe_audio(self.test_audio_file)

          assert result["success"] is True
          assert "Transcribed text from audio" in result["transcription"]
          mock_client.files.upload.assert_called_once_with(file=self.test_audio_file)
          mock_client.models.generate_content.assert_called_once()
          mock_client.files.delete.assert_called_once_with(name=mock_uploaded.name)
  ```
- [ ] **Fix `test_gemini_transcribe_audio_file_not_found`.** The new path raises inside `files.upload`, not `open`. Replace its body:
  ```python
      @patch("ai_service.GEMINI_AVAILABLE", True)
      @patch("ai_service.genai")
      def test_gemini_transcribe_audio_file_not_found(self, mock_genai):
          """Upload of a missing file surfaces as success=False."""
          mock_client = mock_genai.Client.return_value
          mock_client.files.upload.side_effect = FileNotFoundError("missing")

          provider = GeminiProvider("test_key")
          result = provider.transcribe_audio("/nonexistent/file.wav")

          assert result["success"] is False
          assert "error" in result
  ```
- [ ] **Fix `test_gemini_analyze_text_insights` and `test_gemini_analyze_text_summary`.** In each, replace:
  ```python
          mock_model.generate_content.return_value = mock_response
          mock_genai.GenerativeModel.return_value = mock_model
  ```
  with:
  ```python
          mock_client = mock_genai.Client.return_value
          mock_client.models.generate_content.return_value = mock_response
  ```
  and replace the trailing `mock_model.generate_content.assert_called_once()` (insights test only) with `mock_client.models.generate_content.assert_called_once()`. Delete the now-unused `mock_model = Mock()` line in each.
- [ ] **Run the ai_service file (PASS).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_ai_service.py --no-cov -p no:cacheprovider -p no:randomly -q 2>&1 | tail -5
  ```
  Expected: 0 failed.
- [ ] **Fix `test_ai_service_focused.py::TestErrorHandling::test_gemini_provider_handles_api_exceptions`.** Open the file, find the test, and convert any `mock_genai.GenerativeModel`/`mock_genai.configure` usage to the `mock_genai.Client.return_value.models.generate_content` form, mirroring the ai_service fixes. Run it:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest "tests/test_ai_service_focused.py::TestErrorHandling::test_gemini_provider_handles_api_exceptions" --no-cov -p no:cacheprovider -p no:randomly -q
  ```
  Expected: `1 passed`.
- [ ] **Commit the ai_service fixes.**
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git add apps/desktop/tests/test_ai_service.py apps/desktop/tests/test_ai_service_focused.py && git commit -m "test(desktop): Gate4 3 — realign ai_service Gemini tests to google-genai Client SDK (Client/models.generate_content/files.upload)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```
- [ ] **Fix `test_call_gemini_api_success`.** In `test_transcription_module.py`, replace the old-SDK block:
  ```python
          mock_model = Mock()
          mock_response = Mock()
          mock_response.to_dict.return_value = {"response": "success"}
          mock_model.generate_content.return_value = mock_response
          mock_genai.GenerativeModel.return_value = mock_model

          result = _call_gemini_api(payload, "test_key")

          assert result == {"response": "success"}
          mock_genai.configure.assert_called_once_with(api_key="test_key")
          mock_genai.GenerativeModel.assert_called_once_with("gemini-1.5-flash")
          mock_model.generate_content.assert_called_once_with("test content", generation_config={"temperature": 0.5})
  ```
  with the new Client contract (`_call_gemini_api` passes `model=`, `contents=`, `config=generationConfig` and returns `response.to_dict()` — src:90-96):
  ```python
          mock_response = Mock()
          mock_response.to_dict.return_value = {"response": "success"}
          mock_client = mock_genai.Client.return_value
          mock_client.models.generate_content.return_value = mock_response

          result = _call_gemini_api(payload, "test_key")

          assert result == {"response": "success"}
          mock_genai.Client.assert_called_once_with(api_key="test_key")
          mock_client.models.generate_content.assert_called_once_with(
              model="gemini-2.0-flash-exp", contents="test content", config={"temperature": 0.5}
          )
  ```
- [ ] **Fix `test_call_gemini_api_exception`.** The old code raised via `genai.configure`; the new code raises at `genai.Client(...)`. Replace:
  ```python
          mock_genai.configure.side_effect = Exception("API error")
  ```
  with:
  ```python
          mock_genai.Client.side_effect = Exception("API error")
  ```
- [ ] **Fix `test_call_gemini_api_model_exception`.** Replace:
  ```python
          mock_model = Mock()
          mock_model.generate_content.side_effect = Exception("Model error")
          mock_genai.GenerativeModel.return_value = mock_model
  ```
  with:
  ```python
          mock_client = mock_genai.Client.return_value
          mock_client.models.generate_content.side_effect = Exception("Model error")
  ```
- [ ] **Fix the 6 `TestProcessAudioFileForInsights` + utilities tests (combined-path drift).** These mock `transcription_module.transcribe_audio` + `extract_meeting_insights`, but for `provider == "gemini"` the code now calls `ai_service.get_provider("gemini").transcribe_and_analyze_audio(path, language)` (src:361-370), which runs unmocked and fails with "is not a valid file path." For each failing test in `TestProcessAudioFileForInsights` and the `TestTranscriptionModuleUtilities` process_audio tests, add a patch of the combined path. Pattern (apply to `test_process_audio_file_success`):
  ```python
      @pytest.mark.asyncio
      @patch("transcription_module.os.path.exists")
      @patch("transcription_module.ai_service")
      async def test_process_audio_file_success(self, mock_ai_service, mock_exists):
          """Realigned (Gate 4 Task 3): gemini provider uses the combined
          transcribe_and_analyze_audio single-call path."""
          mock_exists.return_value = True
          mock_ai_service.configure_provider.return_value = True
          mock_provider = Mock()
          mock_provider.transcribe_and_analyze_audio.return_value = {
              "success": True,
              "transcription": "Meeting transcription text",
              "analysis": {
                  "summary": "Project meeting summary",
                  "action_items": ["Task 1", "Task 2"],
                  "topics": ["project"],
                  "sentiment": "neutral",
              },
          }
          mock_ai_service.get_provider.return_value = mock_provider

          result = await process_audio_file_for_insights("/test/audio.wav", "gemini", "test_key")

          assert result["transcription"] == "Meeting transcription text"
          assert result["insights"]["summary"] == "Project meeting summary"
          assert len(result["insights"]["action_items"]) == 2
          assert result["insights"]["category"] == "Meeting"
  ```
  For the transcription-failure / exception / hta variants, set `transcribe_and_analyze_audio.return_value = {"success": False, "error": ...}` or `.side_effect = Exception(...)` and assert the `error` key. For the `.hta`/`.hda` conversion tests, keep `os.path.exists` True and additionally patch `transcription_module.shutil.copy2`. Read each test body and adapt the analysis dict to the assertion it makes (`category` is "Meeting" iff `topics` is non-empty — src:379).
- [ ] **Run the transcription file (PASS).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_transcription_module.py --no-cov -p no:cacheprovider -p no:randomly -q 2>&1 | tail -5
  ```
  Expected: 0 failed.
- [ ] **Run all three Family B files together (PASS).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_ai_service.py tests/test_ai_service_focused.py tests/test_transcription_module.py --no-cov -p no:cacheprovider -p no:randomly -q 2>&1 | tail -3
  ```
  Expected: `118 passed` (96 + 22), 0 failed.
- [ ] **Commit the transcription fixes.**
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git add apps/desktop/tests/test_transcription_module.py && git commit -m "test(desktop): Gate4 3 — realign transcription_module tests to genai Client + combined transcribe_and_analyze_audio path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 4: Fix the 1 connection-recovery test

Spec §5 slice 4: preserve the `device_test_*` harness + the conftest-documented no-libusb soft-skip; do not rewrite against a fresh inline mock.

> **Verified discrepancy (record in report):** the spec assumes the test fails due to mock-drift. On this workstation a libusb backend IS available, so `backend is None` (line 49) is False and the test proceeds to `adapter.connect()`, which raises `ConnectionError: Device VID=... not found.` (no device plugged in). The existing `except` (line 99-104) only soft-skips on `"Access denied"`/`"permission"`, NOT on `"not found"`. The sibling `test_gui_connection_retry_logic` already soft-skips on `"not found"` (line 154-155). The fix is to extend the recovery test's `except` with the same "no device to test" branch — matching the conftest contract, not bypassing it.

**Files:**
- Modify (Test): `apps/desktop/tests/test_connection_recovery_integration.py`

- [ ] **Reproduce the failure.** Run (note `-m ""` to include integration/device markers):
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest "tests/test_connection_recovery_integration.py::test_connection_recovery_after_error" -m "" --no-cov -p no:cacheprovider -p no:randomly -q 2>&1 | tail -8
  ```
  Expected: `1 failed` — `ConnectionError: Failed to connect to device: Device VID=... not found.`
- [ ] **Extend the soft-skip to cover "device not found".** In `test_connection_recovery_after_error`, the `except Exception as e:` block (around line 99) currently reads:
  ```python
              except Exception as e:
                  error_msg = str(e)
                  if "Access denied" in error_msg or "permission" in error_msg.lower():
                      pytest.skip(f"Device access denied - skipping test: {e}")
                  else:
                      raise
  ```
  Change it to add the "no device to test" soft-skip (mirroring `test_gui_connection_retry_logic` line 154-155):
  ```python
              except Exception as e:
                  error_msg = str(e)
                  if "Access denied" in error_msg or "permission" in error_msg.lower():
                      pytest.skip(f"Device access denied - skipping test: {e}")
                  # No HiDock device plugged in — the recovery path is
                  # unreachable, so treat as a soft skip rather than a hard
                  # failure (matches test_gui_connection_retry_logic + the
                  # conftest no-libusb/no-device contract).
                  if "not found" in error_msg.lower():
                      pytest.skip(f"No HiDock device found on this workstation: {e}")
                  raise
  ```
- [ ] **Run the recovery test (SKIP on this workstation = PASS-equivalent).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest "tests/test_connection_recovery_integration.py::test_connection_recovery_after_error" -m "" --no-cov -p no:cacheprovider -p no:randomly -q 2>&1 | tail -4
  ```
  Expected: `1 skipped` (reason: "No HiDock device found...") — NOT failed. On a device-equipped machine it would run and pass.
- [ ] **Commit.**
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git add apps/desktop/tests/test_connection_recovery_integration.py && git commit -m "test(desktop): Gate4 4 — soft-skip connection-recovery test when no HiDock device is present (matches no-device contract)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```
- [ ] **Verify the default suite is fully green (no `-m ""`, hung files now included).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests --no-cov -p no:randomly -q 2>&1 | tail -5
  ```
  Expected: `0 failed` (everything passes or skips). This is the §6 done-criterion #2: 63→0.

---

### Task 5: New Class-A coverage (worked example + repeatable procedure)

Raise the largely-untested allowlist modules toward 80%. **Order by absolute missing-statement count, highest first** for fastest floor movement. Spec §4 allowlist / §5 slice 5.

**The repeatable per-module procedure (apply to each module):**
1. Establish a fresh `.coverage` from a `pytest --cov` run that includes the existing tests (data MUST come from `pytest --cov`, not `coverage run --source=src` — the latter records false 0% for conftest-imported modules; spec §4 Part 2).
2. Measure missing lines for the module:
   ```bash
   cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m coverage report --include=src/<module>.py --show-missing
   ```
3. Read the named missing line ranges in `src/<module>.py`; write a failing test that exercises a real uncovered function (pure logic — no display/USB/network).
4. Run the new test file `--no-cov` to PASS; re-measure step 2; iterate until the module's coverage line shows `>= 80%`.
5. Commit per module.

**Allowlist modules largely untested (target first, by size):** `oauth2_token_manager.py` (480 LOC), `audio_metadata_db.py` (785 LOC), `calendar_filter_engine.py` (391 LOC), `gemini_models.py` (283 LOC), `oauth2_pkce.py` (166 LOC); **extend** the partial `calendar_cache_manager.py` tests (`test_high_impact_coverage.py:120`).

**Files:**
- Create (Test): `apps/desktop/tests/test_oauth2_token_manager.py`, `apps/desktop/tests/test_gemini_models.py`, `apps/desktop/tests/test_oauth2_pkce.py`, `apps/desktop/tests/test_calendar_filter_engine.py`, `apps/desktop/tests/test_audio_metadata_db_gate4.py`
- Modify (Test): `apps/desktop/tests/test_high_impact_coverage.py`

#### Fully-worked example: `oauth2_token_manager.py` (highest-missing, 0% covered)

- [ ] **Measure baseline missing lines.** First refresh coverage data, then report:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_high_impact_coverage.py --cov=. -p no:randomly -q >/dev/null 2>&1; ./.venv.win/Scripts/python.exe -m coverage report --include=src/oauth2_token_manager.py
  ```
  Expected: a line `src/oauth2_token_manager.py   NNN   NNN   0%` (≈480 stmts, ≈0% covered — the biggest single floor lever).
- [ ] **Write the first failing test — `save_tokens`/`load_tokens` encrypted round-trip.** `OAuth2TokenManager.save_tokens` (src:139) encrypts `access_token`/`refresh_token` with Fernet and writes JSON; `load_tokens` (src:192) decrypts. Both are pure local logic (no network). The constructor takes a `config_dir` so we point it at a tmp dir. Create `apps/desktop/tests/test_oauth2_token_manager.py`:
  ```python
  """Gate 4 (Task 5) coverage for oauth2_token_manager.OAuth2TokenManager.

  Pure local logic: Fernet encryption + JSON file storage. No network.
  """

  import pytest
  from oauth2_token_manager import OAuth2TokenManager

  pytest.importorskip("cryptography")


  @pytest.fixture
  def manager(tmp_path):
      """An OAuth2TokenManager rooted at an isolated tmp config dir."""
      return OAuth2TokenManager(config_dir=str(tmp_path / "oauth_cfg"))


  class TestSaveLoadRoundTrip:
      def test_save_then_load_decrypts_tokens(self, manager):
          tokens = {
              "access_token": "AT-secret-123",
              "refresh_token": "RT-secret-456",
              "expires_in": 3600,
              "token_type": "Bearer",
          }
          assert manager.save_tokens("microsoft", tokens) is True

          loaded = manager.load_tokens("microsoft")
          assert loaded is not None
          # Decrypted values must round-trip to the originals.
          assert loaded["access_token"] == "AT-secret-123"
          assert loaded["refresh_token"] == "RT-secret-456"
          # save_tokens stamps expires_at + saved_at.
          assert "expires_at" in loaded
          assert "saved_at" in loaded

      def test_load_unknown_provider_returns_none(self, manager):
          assert manager.load_tokens("google") is None

      def test_tokens_are_encrypted_at_rest(self, manager, tmp_path):
          manager.save_tokens("microsoft", {"access_token": "AT-secret-123", "expires_in": 60})
          raw = (tmp_path / "oauth_cfg" / "oauth2_tokens.json").read_text(encoding="utf-8")
          # The plaintext secret must NOT appear on disk.
          assert "AT-secret-123" not in raw
  ```
- [ ] **Run it (PASS — this is coverage-adding, not bugfixing).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_oauth2_token_manager.py --no-cov -p no:cacheprovider -p no:randomly -q
  ```
  Expected: `3 passed`.
- [ ] **Re-measure and iterate to ≥80%.** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_oauth2_token_manager.py --cov=. -p no:randomly -q >/dev/null 2>&1; ./.venv.win/Scripts/python.exe -m coverage report --include=src/oauth2_token_manager.py --show-missing
  ```
  Then add tests for the still-missing named lines: `is_token_valid` (src:249 — valid/expired/no-expiry/missing branches; mock `expires_at` via a saved token with a past vs future ISO timestamp), `get_access_token`, `clear_tokens`/`delete_tokens`, `_load_tokens_file` JSON-decode-error branch (write a corrupt `oauth2_tokens.json` then assert it returns `{}`), and the `_decrypt` failure path (feed a non-base64 string → assert it raises). Re-run the report after each addition until `src/oauth2_token_manager.py` shows `>= 80%`.
- [ ] **Commit the module.**
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git add apps/desktop/tests/test_oauth2_token_manager.py && git commit -m "test(desktop): Gate4 5 — oauth2_token_manager.py to >=80% (encrypted token round-trip, validity, error paths)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

#### Remaining Task-5 modules (apply the per-module procedure above)

- [ ] **`gemini_models.py`** — Create `tests/test_gemini_models.py`. Measure with `coverage report --include=src/gemini_models.py --show-missing`. Cover the pure helpers the codebase already relies on: `normalize_model_name`, `is_valid_model_name`, `validate_model_for_transcription` (these are imported by `ai_service.py`). Write a first failing test asserting `normalize_model_name("gemini-pro")` returns a known canonical name and `is_valid_model_name("gemini-2.0-flash-exp")` is True / a junk name is False. Iterate to ≥80%. Commit.
- [ ] **`oauth2_pkce.py`** — Create `tests/test_oauth2_pkce.py`. Cover PKCE code-verifier/code-challenge generation (pure crypto, deterministic given a seed or assertable by shape: verifier length 43-128, challenge is URL-safe base64 of SHA-256). Iterate to ≥80%. Commit.
- [ ] **`calendar_filter_engine.py`** — Create `tests/test_calendar_filter_engine.py`. Cover the filter/predicate logic (date-range, keyword, all-day filters) with in-memory event dicts (no Outlook). Iterate to ≥80%. Commit.
- [ ] **`audio_metadata_db.py`** — Create `tests/test_audio_metadata_db_gate4.py`. Cover the SQLite CRUD against an in-memory or tmp-path DB (insert metadata → query → update → delete). Use the `database_cleanup` conftest fixture to close connections. Iterate to ≥80%. Commit.
- [ ] **Extend `calendar_cache_manager.py`** — in `tests/test_high_impact_coverage.py`, expand `test_calendar_cache_manager` (currently a smoke import at line 120) into real cache get/set/expiry assertions until `coverage report --include=src/calendar_cache_manager.py` shows ≥80%. Commit.

---

### Task 6: Branch/edge top-up to the per-module 80% bar + `hidock_device` pure helpers

Push every remaining Part-2 allowlist module to ≥80% and add `hidock_device.py` pure-helper tests toward the whole-app floor. Spec §4 Part 2 / §5 slice 6. (Slices 5 and 6 share the §4 Part-2 success criterion; they may run as one continuous effort sequenced by module.)

**Files:**
- Modify/Create (Test): top-up files for `file_operations_manager.py`, `storage_management.py`, `device_interface.py`, `hta_converter.py`, `config_and_logger.py` as the per-module measurement dictates
- Create (Test): `apps/desktop/tests/test_hidock_device_helpers_gate4.py`

- [ ] **Measure each remaining allowlist module and top up to ≥80%.** For each of `file_operations_manager.py`, `storage_management.py`, `device_interface.py`, `hta_converter.py`, `audio_metadata_db.py`, `calendar_cache_manager.py`, `calendar_filter_engine.py`, `config_and_logger.py` (the ones not already ≥80% after Task 5), run the per-module measure-then-fill procedure from Task 5:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m coverage report --include=src/<module>.py --show-missing
  ```
  Add edge/branch tests for the named missing lines into the existing per-module test file (or a new `test_<module>_gate4.py`). Commit per module.
- [ ] **Write the first failing test for `_build_packet`** (pure packet assembly, no USB). `_build_packet(command_id, body_bytes)` builds `0x12 0x34` sync + 2-byte BE command id + 4-byte BE sequence + 4-byte BE body length + body (src:790-797). Create `apps/desktop/tests/test_hidock_device_helpers_gate4.py`:
  ```python
  """Gate 4 (Task 6) — pure-helper tests for hidock_device (no USB).

  Targets the whole-app floor (Part 1); hidock_device.py is deliberately NOT
  in the per-module 80% allowlist (it is fused with USB hardware).
  """

  import struct
  from unittest.mock import Mock

  import pytest
  from constants import CMD_GET_FILE_LIST
  from hidock_device import HiDockJensen

  pytestmark = pytest.mark.timeout(20)


  @pytest.fixture
  def jensen():
      dev = HiDockJensen(Mock())
      dev.sequence_id = 0
      return dev


  class TestBuildPacket:
      def test_build_packet_header_shape(self, jensen):
          body = b"\x01\x02\x03"
          packet = jensen._build_packet(CMD_GET_FILE_LIST, body)

          # sync marker
          assert packet[0] == 0x12 and packet[1] == 0x34
          cmd_id, seq_id, body_len = struct.unpack(">HII", packet[2:12])
          assert cmd_id == CMD_GET_FILE_LIST
          assert seq_id == 1  # sequence_id incremented from 0
          assert body_len == len(body)
          assert packet[12:] == body

      def test_build_packet_empty_body(self, jensen):
          packet = jensen._build_packet(CMD_GET_FILE_LIST)
          _, _, body_len = struct.unpack(">HII", packet[2:12])
          assert body_len == 0
          assert len(packet) == 12

      def test_sequence_id_increments(self, jensen):
          p1 = jensen._build_packet(CMD_GET_FILE_LIST)
          p2 = jensen._build_packet(CMD_GET_FILE_LIST)
          seq1 = struct.unpack(">I", p1[4:8])[0]
          seq2 = struct.unpack(">I", p2[4:8])[0]
          assert seq2 == seq1 + 1
  ```
- [ ] **Run it (PASS).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_hidock_device_helpers_gate4.py --no-cov -p no:cacheprovider -p no:randomly -q
  ```
  Expected: `3 passed`.
- [ ] **Add the inbound 24-bit body-length parse test.** The parse is inline in `_receive_response` (src:973-980): `body_len = body_len_from_header & 0x00FFFFFF`, `checksum_len = (body_len_from_header >> 24) & 0xFF`, `total_msg_len = 12 + body_len + checksum_len`. Test it by driving `_receive_response` with a mocked `device.read` that returns a single well-formed packet whose 4-byte length field has a non-zero upper (checksum) byte, asserting the parsed body excludes the checksum-length bits. Add a `TestReceiveLengthParse` class that mocks `jensen.is_connected` → True, sets `jensen.ep_in`/`device` Mocks, primes `jensen.receive_buffer` with a hand-built packet `bytes([0x12,0x34]) + struct.pack(">HII", CMD_GET_FILE_LIST, 1, (0x01<<24)|3) + b"\x00\x00\x00body_checksum_pad"`, and asserts the returned dict `body` length is 3 (lower 24 bits), not 3 + checksum. Run `--no-cov` to PASS.
- [ ] **Commit the helper tests.**
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git add apps/desktop/tests/test_hidock_device_helpers_gate4.py && git commit -m "test(desktop): Gate4 6 — hidock_device pure-helper tests (_build_packet, 24-bit body-length parse) toward whole-app floor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```
- [ ] **Verify every allowlist module is ≥80% (dry run of the Part-2 loop, before wiring CI).** Run after a fresh full `--cov` data run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests --cov=. -p no:randomly -q >/dev/null 2>&1; for m in file_operations_manager storage_management audio_metadata_db device_interface hta_converter calendar_cache_manager calendar_filter_engine gemini_models oauth2_pkce oauth2_token_manager config_and_logger; do echo -n "$m: "; ./.venv.win/Scripts/python.exe -m coverage report --include=src/$m.py --fail-under=80 >/dev/null 2>&1 && echo PASS || echo FAIL; done
  ```
  Expected: all 11 print `PASS`. Any `FAIL` → return to its per-module top-up before Task 7.

---

### Task 7: Install + measure the gate (authoritative measurement + CI wiring)

One authoritative clean `--cov` run sets the Part-1 floor; the Part-2 per-module loop is wired into CI; the duplicated connected-Jensen fixture is consolidated into `conftest.py`. Spec §4 / §5 slice 7 / §6 #3-#4.

**Files:**
- Modify: `apps/desktop/pyproject.toml` (`[tool.coverage.report]` `fail_under`, `[tool.coverage.run]` `omit`), the CI workflow file, `apps/desktop/tests/conftest.py`

- [ ] **Authoritative full `--cov` run (milestone run #2).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests --cov=. --cov-report=term-missing -p no:randomly -q 2>&1 | tail -10
  ```
  Expected: `0 failed`; record the final `TOTAL ... NN%`. Let `floor = floor(NN)`; the Part-1 gate is `N = floor − 1`.
- [ ] **Add `jensen_protocol_extensions.py` to the coverage omit (dead stub — spec §1 B3).** In `apps/desktop/pyproject.toml`, in `[tool.coverage.run]`, add to the `omit` list (after `"themes/*",`):
  ```toml
      "themes/*",
      "src/jensen_protocol_extensions.py",
  ```
- [ ] **Set the Part-1 static floor.** In `apps/desktop/pyproject.toml`, in `[tool.coverage.report]` (the table `coverage`/`pytest-cov` actually read — spec §4 Part 1), add a `fail_under` line above `exclude_lines`:
  ```toml
  [tool.coverage.report]
  fail_under = N   # Gate 4 Part-1 static floor = floor(measured) - 1; raise manually as coverage rises (no auto-ratchet)
  exclude_lines = [
  ```
  Replace `N` with the integer from the measurement step.
- [ ] **Verify the floor passes.** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m coverage report 2>&1 | tail -3; echo "RC=$?"
  ```
  Expected: `TOTAL ... NN%` and `RC=0` (since `NN >= N`). A non-zero RC means `fail_under` was set too high — lower `N` to `floor − 1`.
- [ ] **Commit the gate config.**
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git add apps/desktop/pyproject.toml && git commit -m "build(desktop): Gate4 7 — add Part-1 fail_under floor + omit dead jensen_protocol_extensions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```
- [ ] **First fix the STALE desktop CI job, then add the Part-2 loop.** `.github/workflows/ci.yml`'s desktop job is stale: all its desktop steps use `working-directory: ./hidock-desktop-app` (a path that **no longer exists** — the app is at `apps/desktop`) and the test step runs `pytest tests/` with **no `--cov`**, so there is no `pytest --cov` step to anchor to. Fix it as part of wiring the gate:
  - (a) In `.github/workflows/ci.yml`, change every desktop-job `working-directory: ./hidock-desktop-app` to `apps/desktop` (the flake8/black/mypy/pytest steps).
  - (b) Change the `Test with pytest` step's `run:` from `pytest tests/` to produce coverage data (CI uses the runner's system `python`, not `.venv.win`):
    ```yaml
        - name: Test with pytest
          working-directory: apps/desktop
          run: |
            python -m pytest tests/ --cov=. --cov-report=xml
    ```
  - (c) THEN add the Part-2 step immediately after it (so `.coverage` exists from the `--cov` run — spec §4: data MUST come from `pytest --cov`, not `coverage run`). The step (bash):
  ```yaml
        - name: Gate 4 Part-2 — per-module 80% on critical mockable allowlist
          working-directory: apps/desktop
          run: |
            set -e
            modules="file_operations_manager storage_management audio_metadata_db device_interface hta_converter calendar_cache_manager calendar_filter_engine gemini_models oauth2_pkce oauth2_token_manager config_and_logger"
            fail=0
            for m in $modules; do
              if python -m coverage report --include=src/$m.py --fail-under=80 >/dev/null 2>&1; then
                echo "PASS  $m >= 80%"
              else
                echo "FAIL  $m < 80%"
                fail=1
              fi
            done
            exit $fail
  ```
  (A single-file `--include` makes the aggregate == that one file, so each module is gated independently — a 0% module cannot hide behind well-covered siblings; spec §4 Part 2.)
- [ ] **Dry-run the exact loop locally.** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests --cov=. -p no:randomly -q >/dev/null 2>&1; for m in file_operations_manager storage_management audio_metadata_db device_interface hta_converter calendar_cache_manager calendar_filter_engine gemini_models oauth2_pkce oauth2_token_manager config_and_logger; do ./.venv.win/Scripts/python.exe -m coverage report --include=src/$m.py --fail-under=80 >/dev/null 2>&1 && echo "PASS $m" || echo "FAIL $m"; done
  ```
  Expected: 11× `PASS`.
- [ ] **Consolidate the duplicated connected-Jensen fixture into `conftest.py`.** The `device = HiDockJensen(Mock()); device.device = Mock(); device.ep_in/ep_out = Mock(); device.is_connected_flag = True; device.device_info = {...}` block is copy-pasted ~24× across 5 device test files. Add a shared fixture to `apps/desktop/tests/conftest.py`:
  ```python
  @pytest.fixture
  def connected_jensen():
      """A HiDockJensen wired for mock-only protocol tests (Gate 4 Task 7).

      Consolidates the connected-device fixture copy-pasted across
      test_hidock_device_*.py. No real USB — device/endpoints are Mocks.
      """
      from hidock_device import HiDockJensen

      device = HiDockJensen(Mock())
      device.device = Mock()
      device.ep_in = Mock()
      device.ep_out = Mock()
      device.is_connected_flag = True
      device.device_info = {"versionNumber": 12345}
      return device
  ```
  (Do NOT mass-migrate all 24 call sites in this task — leave the per-file `jensen_device` fixtures in place to avoid a churny diff; the shared fixture is available for new tests and incremental adoption. Mention the availability in the commit.)
- [ ] **Verify conftest still imports cleanly.** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_hidock_device_commands.py --no-cov -p no:cacheprovider -p no:randomly -q 2>&1 | tail -3
  ```
  Expected: collection + run succeed (the new fixture doesn't break existing ones).
- [ ] **Commit CI wiring + shared fixture.**
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git add .github/workflows apps/desktop/tests/conftest.py && git commit -m "ci(desktop): Gate4 7 — wire Part-2 per-module 80% loop + consolidate connected_jensen fixture

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 8: Production loop-hardening (reviewed prod change, TDD)

Bound the two genuinely-unbounded mismatch loops in `hidock_device.py` so a stuck/mismatched packet stream can no longer spin forever. Add a `consecutive_mismatch` cap that **resets on each valid `CMD_GET_FILE_LIST` chunk** (mirroring the existing `consecutive_timeouts` reset). Spec §3 / §5 slice 8 / §6 #5.

> **Verified anchors:** the two real unbounded `else: continue` branches are:
> - `list_files` — src:1999-2007 (`else:` logs "Unexpected response" and `continue` without advancing any counter).
> - `_receive_all_chunks_for_parallel` — src:1634-1635 (`else: continue  # Unexpected response`). NOTE: `list_files_parallel` itself just delegates and has no loop — do NOT touch it.
> `_attempt_connection` is already bounded (retry ≤ 3, flush ≤ 10) — do **NOT** touch it. `stream_file`'s empty-chunk path (src:2386-2400) is already wall-clock-bounded (`end_time = start_time + timeout_s`, default 180s) and its unexpected-response `else` (src:2421-2428) already `break`s — leave it (optional tighten only, with a cap generous enough not to abort a slow valid transfer).

**Files:**
- Create (Test): `apps/desktop/tests/test_hidock_device_loop_bounds.py`
- Modify: `apps/desktop/src/hidock_device.py`

- [ ] **Write the termination test FIRST (it must hang→fail under the timeout marker before the fix).** A constant mismatched-id `return_value` hits `list_files`' `else: continue` forever. Create `apps/desktop/tests/test_hidock_device_loop_bounds.py`:
  ```python
  """Gate 4 (Task 8) — production loop-termination guarantees for hidock_device.

  These assert that list_files and _receive_all_chunks_for_parallel cannot
  spin forever on a stuck mismatched-id packet stream. They are written TDD:
  before the bound is added they fail via the 10s timeout marker; after the
  bound they pass fast with a terminating status.
  """

  from unittest.mock import Mock, patch

  import pytest
  from constants import CMD_GET_FILE_LIST
  from hidock_device import HiDockJensen

  # Tighter than the module-level 20s elsewhere: a true spin must fail in 10s.
  pytestmark = pytest.mark.timeout(10)


  @pytest.fixture
  def jensen():
      dev = HiDockJensen(Mock())
      dev.device = Mock()
      dev.ep_in = Mock()
      dev.ep_out = Mock()
      dev.is_connected_flag = True
      dev.device_info = {"versionNumber": 12345}
      return dev


  def test_list_files_terminates_on_stuck_mismatched_packet(jensen):
      """A never-ending stream of wrong-id packets must terminate, not hang."""
      with patch.object(jensen, "_send_command", return_value=1):
          with patch.object(jensen, "_receive_response") as mock_receive:
              # Constant mismatched id: hits the list_files else: continue branch.
              mock_receive.return_value = {"id": 999, "sequence": 1, "body": b"junk"}
              result = jensen.list_files()

      # Must return a finite error result rather than spinning forever.
      assert result is not None
      assert result["totalFiles"] == 0


  def test_parallel_receive_terminates_on_stuck_mismatched_packet(jensen):
      """_receive_all_chunks_for_parallel must terminate on stuck wrong-id packets."""
      with patch.object(jensen, "_send_command", return_value=1):
          with patch.object(jensen, "_receive_response") as mock_receive:
              mock_receive.return_value = {"id": 999, "sequence": 1, "body": b"junk"}
              chunks = jensen._receive_all_chunks_for_parallel(timeout_s=5)

      # Returns the (empty) chunk list rather than hanging.
      assert chunks == []
  ```
- [ ] **Run the test FIRST — it must FAIL via timeout (proves the unbounded loop).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_hidock_device_loop_bounds.py --no-cov -p no:cacheprovider -p no:randomly -q
  ```
  Expected: both tests FAIL with `Failed: Timeout >10.0s` (the loops spin on the constant mismatched id).
- [ ] **Bound the `list_files` mismatch loop.** In `apps/desktop/src/hidock_device.py`, in `list_files`, initialize a mismatch counter alongside the existing timeout counter. Change (src ~1939-1942):
  ```python
                  # Optimized receiving with adaptive timeout
                  final_files = None
                  consecutive_timeouts = 0
                  max_consecutive_timeouts = 10  # Increased for large file lists (488+ files)
                  adaptive_timeout = 1000  # Back to original timeout
  ```
  to add the mismatch cap:
  ```python
                  # Optimized receiving with adaptive timeout
                  final_files = None
                  consecutive_timeouts = 0
                  max_consecutive_timeouts = 10  # Increased for large file lists (488+ files)
                  consecutive_mismatch = 0
                  max_consecutive_mismatch = 50  # Gate 4: bound stuck wrong-id streams
                  adaptive_timeout = 1000  # Back to original timeout
  ```
  Reset the mismatch counter on each valid chunk — in the `if response and response["id"] == CMD_GET_FILE_LIST:` block (after `consecutive_timeouts = 0`, src:1958):
  ```python
                          consecutive_timeouts = 0
                          consecutive_mismatch = 0  # Gate 4: valid chunk resets the mismatch cap
  ```
  And replace the unbounded `else:` branch (src:1999-2007):
  ```python
                      else:
                          # Unexpected response - log and continue
                          logger.debug(
                              "Jensen",
                              "list_files",
                              f"Unexpected response CMD:{response.get('id', 'unknown')} "
                              f"SEQ:{response.get('sequence', 'unknown')} during file list",
                          )
                          continue
  ```
  with a bounded version:
  ```python
                      else:
                          # Unexpected response - count toward the mismatch cap so a
                          # stuck wrong-id stream can't spin forever (Gate 4 Task 8).
                          consecutive_mismatch += 1
                          logger.debug(
                              "Jensen",
                              "list_files",
                              f"Unexpected response CMD:{response.get('id', 'unknown')} "
                              f"SEQ:{response.get('sequence', 'unknown')} during file list "
                              f"({consecutive_mismatch}/{max_consecutive_mismatch})",
                          )
                          if consecutive_mismatch >= max_consecutive_mismatch:
                              logger.warning(
                                  "Jensen",
                                  "list_files",
                                  f"Max consecutive mismatched packets ({max_consecutive_mismatch}) "
                                  f"reached; aborting file list with available data.",
                              )
                              final_files = file_list_handler(b"")  # process whatever we have
                              break
                          continue
  ```
- [ ] **Bound the `_receive_all_chunks_for_parallel` mismatch loop.** In the same file, add the counter alongside its existing timeout counter (src ~1590-1592):
  ```python
                  consecutive_timeouts = 0
                  max_consecutive_timeouts = 10  # Increased for large file lists
                  adaptive_timeout = 1000
  ```
  →
  ```python
                  consecutive_timeouts = 0
                  max_consecutive_timeouts = 10  # Increased for large file lists
                  consecutive_mismatch = 0
                  max_consecutive_mismatch = 50  # Gate 4: bound stuck wrong-id streams
                  adaptive_timeout = 1000
  ```
  Reset on valid chunk — in its `if response and response["id"] == CMD_GET_FILE_LIST:` block (after `consecutive_timeouts = 0`, src:1601):
  ```python
                          consecutive_timeouts = 0
                          consecutive_mismatch = 0  # Gate 4: valid chunk resets the mismatch cap
  ```
  And replace its `else:` branch (src:1634-1635):
  ```python
                      else:
                          continue  # Unexpected response
  ```
  with:
  ```python
                      else:
                          # Unexpected response - bound it (Gate 4 Task 8).
                          consecutive_mismatch += 1
                          if consecutive_mismatch >= max_consecutive_mismatch:
                              logger.warning(
                                  "Jensen",
                                  "parallel_receive",
                                  f"Max consecutive mismatched packets ({max_consecutive_mismatch}) "
                                  f"reached, collected {len(file_list_chunks)} chunks",
                              )
                              break
                          continue  # Unexpected response
  ```
- [ ] **Run the termination tests (now PASS fast).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_hidock_device_loop_bounds.py --no-cov -p no:cacheprovider -p no:randomly -q
  ```
  Expected: `2 passed` in well under 10s (the caps trip after 50 mismatches and return finite results).
- [ ] **Regression-check the device test files (the bound must not break valid listings).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_hidock_device_file_operations.py tests/test_hidock_device_commands.py tests/test_hidock_device_comprehensive.py --no-cov -p no:cacheprovider -p no:randomly -q 2>&1 | tail -4
  ```
  Expected: `0 failed` — the existing valid-listing tests still pass because the counter resets on every valid `CMD_GET_FILE_LIST` chunk (a long valid listing with stray interleaved packets is not falsely aborted).
- [ ] **Commit the production hardening.**
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next && git add apps/desktop/src/hidock_device.py apps/desktop/tests/test_hidock_device_loop_bounds.py && git commit -m "fix(desktop): Gate4 8 — bound list_files + _receive_all_chunks_for_parallel mismatch loops (consecutive_mismatch cap, resets on valid CMD_GET_FILE_LIST chunk)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```
- [ ] **Final full green + gate verification (re-run milestone #2 with the prod change in).** Run:
  ```bash
  cd /c/Users/rcox/hidock-tools/hidock-next/apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests --cov=. --cov-report=term-missing -p no:randomly -q 2>&1 | tail -8
  ```
  Expected: `0 failed`; `TOTAL >= N`; `coverage` exit 0 (Part-1 floor holds). Then re-run the Part-2 loop (Task 6 final step) and confirm 11× `PASS`. If coverage shifted, adjust `fail_under` to the new `floor − 1` and amend the Task-7 config commit.

---

## Done criteria (maps to spec §6)

- [ ] Both previously-hung device files run, bounded by `pytest-timeout` (Task 0a/0b).
- [ ] 0 failing desktop tests — 63→0 (26 deleted in Task 1; 37 fixed across Tasks 0b/2/3/4) plus the 3 newly-surfaced connection-file assertions fixed in Task 0b.
- [ ] Part-1 static `fail_under = floor−1` wired into CI (Task 7).
- [ ] Part-2 per-module 80% on the 11-module allowlist enforced per module (Tasks 5/6/7).
- [ ] Production mismatch-loops bounded with valid-chunk reset (Task 8).
- [ ] Behavioral assertions exist: `list_files` terminates on a stuck non-matching packet (Task 8); `stream_file` terminates within its 180s wall-clock bound on repeated empty chunks (existing `test_stream_file_timeout`); file delete confirms before removing (existing `test_file_operations_gui.py::test_delete_from_device_with_confirmation` — preserve, do not rebuild).
- [ ] Documented out-of-scope: 80%-whole-app not achievable headless; real-Outlook/Gemini/USB E2E are manual-QA / display-CI follow-ups.

## Finishing

- [ ] Open a PR from `gate4-desktop-coverage` into `main` summarizing: informational baseline (Task 0b), authoritative measured % + chosen `fail_under` (Task 7), the 11 allowlist modules at ≥80%, and the bounded production loops. Use superpowers:finishing-a-development-branch.
