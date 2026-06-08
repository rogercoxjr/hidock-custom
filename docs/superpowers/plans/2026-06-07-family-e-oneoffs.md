# Family E — Desktop Test One-Off Drift Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the 13 remaining pre-existing desktop test failures (Family E) so the desktop test suite is at "only the 4 known-untouchable clusters remain" baseline (A=40, B=22, E2 hung=2, 9 JS projects).

**Architecture:** Spec at `docs/superpowers/specs/2026-06-07-family-e-oneoffs-design.md` — 5 sub-clusters (E1–E5). This plan has 5 fix tasks (one per sub-cluster) + 1 verification task.

**Tech Stack:** Python 3.12, pytest 9.0.3, pytest-asyncio 1.4.0 (Mode.STRICT), unittest.mock, `apps/desktop` test suite.

**Constraints:**
- Local commits only, no push.
- USB safety: do not "fix" tests by exercising real hardware.
- Match the phase-2 pattern: short docstrings on each test pointing to the commit that caused the contract change.

---

## Task 1: E3 — String/constants drift (2 failures)

**Files:**
- Modify: `apps/desktop/tests/test_constants.py`
- Modify: `apps/desktop/tests/test_usb_device_selection.py`

- [ ] **Step 1: Read test_constants.py and confirm the failing assertion**

Run: `cd apps/desktop && .venv.win/Scripts/python.exe -m pytest tests/test_constants.py::TestConstants::test_usb_device_constants --no-header -q --tb=line`
Expected: `assert 44812 == 45069` confirming the assertion is `DEFAULT_PRODUCT_ID == 0xB00D`.

- [ ] **Step 2: Update the assertion to match post-refactor default**

In `apps/desktop/tests/test_constants.py`, find `test_usb_device_constants` and change the assertion to:
```python
assert constants.DEFAULT_PRODUCT_ID == 0xAF0C
```
Add a 2-line docstring/comment noting the post-refactor default is H1 (most common model). Use the docstring style from `test_config_and_logger.py` (phase-2 Task 4).

- [ ] **Step 3: Run the test to confirm it passes**

Run: `cd apps/desktop && .venv.win/Scripts/python.exe -m pytest tests/test_constants.py::TestConstants::test_usb_device_constants --no-header -q`
Expected: PASS (1 passed).

- [ ] **Step 4: Update test_usb_device_selection.py::test_hidock_model_names**

In `apps/desktop/tests/test_usb_device_selection.py`, find `test_hidock_model_names` and change:
```python
assert selector._get_hidock_model_name(0xAF0D) == "Device"
```
to:
```python
assert selector._get_hidock_model_name(0xAF0D) == "H1E"
```
Add a 2-line comment noting the placeholder "Device" was replaced with the real model name in the production lookup.

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd apps/desktop && .venv.win/Scripts/python.exe -m pytest tests/test_usb_device_selection.py::TestEnhancedDeviceSelector::test_hidock_model_names --no-header -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/rcox/hidock-tools/hidock-next
git add apps/desktop/tests/test_constants.py apps/desktop/tests/test_usb_device_selection.py
git commit -m "fix(tests): Family E3 — update test_constants + test_usb_device_selection for post-refactor defaults

The 5a3a9c9d refactor changed constants.DEFAULT_PRODUCT_ID from 0xB00D (H1E) to
0xAF0C (H1) — the most common model. enhanced_device_selector._get_hidock_model_name
also now returns the real model name (\"H1E\") instead of the placeholder string
(\"Device\"). Aligning the 2 affected tests with the current contract."
```

---

## Task 2: E4 — Async marker missing (1 failure)

**Files:**
- Modify: `apps/desktop/tests/test_connection_recovery_integration.py`

- [ ] **Step 1: Confirm the failure is the missing-marker error**

Run: `cd apps/desktop && .venv.win/Scripts/python.exe -m pytest tests/test_connection_recovery_integration.py::test_connection_recovery_after_error --no-header -q --tb=line`
Expected: `async def functions are not natively supported.`

- [ ] **Step 2: Add `@pytest.mark.asyncio` to the test**

In `apps/desktop/tests/test_connection_recovery_integration.py`, find `async def test_connection_recovery_after_error` and add the marker directly above:
```python
@pytest.mark.asyncio
async def test_connection_recovery_after_error():
    ...
```

- [ ] **Step 3: Run the test**

Run: `cd apps/desktop && .venv.win/Scripts/python.exe -m pytest tests/test_connection_recovery_integration.py::test_connection_recovery_after_error --no-header -q`
Expected: PASS, or a different real failure (in which case the real failure is in scope for a follow-up task — surface it and stop).

- [ ] **Step 4: Commit**

```bash
cd C:/Users/rcox/hidock-tools/hidock-next
git add apps/desktop/tests/test_connection_recovery_integration.py
git commit -m "fix(tests): Family E4 — add @pytest.mark.asyncio to test_connection_recovery_after_error

Same class of fix as f63c3294 (phase-2 Cluster 2). The file is mixed
async/sync, so the audit missed this one. pytest-asyncio 1.4.0 in
Mode.STRICT requires the marker on every async test."
```

---

## Task 3: E2 — Contract drift in test_device_fallback_mocked.py (5 failures)

**Files:**
- Modify: `apps/desktop/tests/test_device_fallback_mocked.py`

- [ ] **Step 1: Confirm the 5 failing tests and capture the actual contract values**

Run: `cd apps/desktop && .venv.win/Scripts/python.exe -m pytest tests/test_device_fallback_mocked.py --no-header -q --tb=line 2>&1 | grep -E "^E\s" | head -20`
Expected: 5 AssertionError lines, including:
- `assert 6 == 3` (discovery count)
- `assert 2 == 1` (single-device count)
- `connect(..., auto_retry=True, ...)` expected but actual `auto_retry=False`
- `connect(..., pid=45069, ...)` expected but actual `pid=44812`

- [ ] **Step 2: Update test_discover_all_device_types**

Change `assert len(discovered) == 3` to `assert len(discovered) == 6`. Add a docstring:
```python
def test_discover_all_device_types(self):
    """Production now iterates 2 vendor IDs per model (10d6 + 3887),
    so discover returns 6 entries (3 models × 2 VIDs). 5a3a9c9d change.
    """
```

- [ ] **Step 3: Update test_discover_single_device**

Change `assert len(discovered) == 1` to `assert len(discovered) == 2`. Add a docstring noting the 2-vendor discovery.

- [ ] **Step 4: Update test_connect_configured_device_success**

In the `mock_jensen.connect.assert_called_once_with(...)` call, change `auto_retry=True` to `auto_retry=False`. Add a docstring:
```python
def test_connect_configured_device_success(self):
    """Post-fd1ca915, the default for auto_retry in Jensen.connect
    is False (caller must opt in). Old contract defaulted to True.
    """
```

- [ ] **Step 5: Update test_connect_invalid_device_id_format**

Change `auto_retry=True` to `auto_retry=False` AND change the expected `pid=45069` to `pid=44812` (H1 is the first match in the new iteration order).

- [ ] **Step 6: Update test_connect_no_device_id_uses_defaults**

Change `auto_retry=True` to `auto_retry=False`. Verify the expected PID is correct by reading the test (the connect() iterates VID pairs starting with the H1 = af0c = 44812).

- [ ] **Step 7: Run the file**

Run: `cd apps/desktop && .venv.win/Scripts/python.exe -m pytest tests/test_device_fallback_mocked.py --no-header -q`
Expected: All tests pass (5 previously failing + the rest of the file's passing tests).

- [ ] **Step 8: Commit**

```bash
cd C:/Users/rcox/hidock-tools/hidock-next
git add apps/desktop/tests/test_device_fallback_mocked.py
git commit -m "fix(tests): Family E2 — align test_device_fallback_mocked with post-5a3a9c9d/fd1ca915 contract

Two contract changes affect this file:
1. discover_all_devices now iterates 2 vendor IDs (10d6 + 3887) per model,
   returning 6 entries (3 models × 2 VIDs) instead of 3.
2. Jensen.connect's auto_retry default flipped from True to False in the
   fd1ca915 refactor. The connect-with-no-device-id path also iterates VID
   pairs and now hits the H1 (af0c) first, not the H1E (b00d)."
```

---

## Task 4: E5 — pydub mock leakage (1 failure)

**Files:**
- Modify: `apps/desktop/tests/test_hta_converter.py`

- [ ] **Step 1: Read hta_converter.py to find the pydub import path**

Use Read on `apps/desktop/src/hta_converter.py` and grep for `pydub` or `AudioSegment`. Identify whether it uses `from pydub import AudioSegment` (→ patch target is `hta_converter.AudioSegment.from_mp3`) or `import pydub` (→ patch target is `pydub.AudioSegment.from_mp3`).

- [ ] **Step 2: Update the @patch decorator in test_parse_hta_format_1_pydub_success**

In `apps/desktop/tests/test_hta_converter.py`, find the test and update the `@patch(...)` decorator to target the correct lookup path. If the production code uses `from pydub import AudioSegment` then:
```python
@patch("hta_converter.AudioSegment.from_mp3")
```
If it uses `import pydub`:
```python
@patch("pydub.AudioSegment.from_mp3")
```

- [ ] **Step 3: Run the test**

Run: `cd apps/desktop && .venv/win/Scripts/python.exe -m pytest tests/test_hta_converter.py::TestMPEGFormatParsing::test_parse_hta_format_1_pydub_success --no-header -q`
Expected: PASS (1 passed).

- [ ] **Step 4: Commit**

```bash
cd C:/Users/rcox/hidock-tools/hidock-next
git add apps/desktop/tests/test_hta_converter.py
git commit -m "fix(tests): Family E5 — fix pydub @patch target in test_parse_hta_format_1_pydub_success

The test was patching pydub at the wrong import path, so the real pydub
was called on the synthetic test bytes, failed with '<=' not supported
between int and Mock, and the test saw the original bytes echoed back.
Aligned the @patch target with the import path used in hta_converter.py."
```

---

## Task 5: E1 — Real-USB leakage (5 failures)

**Files:**
- Modify: `apps/desktop/tests/conftest.py`
- Modify: `apps/desktop/tests/test_device_reset.py`
- Modify: `apps/desktop/tests/test_device_reset_simple.py`
- Modify: `apps/desktop/tests/test_connection_recovery_integration.py`

- [ ] **Step 1: Read conftest.py to understand current fixture structure**

Use Read on `apps/desktop/tests/conftest.py`. Identify the existing `setup_test_environment` autouse fixture (added in phase-2 commit `864a9f87`) and any other fixtures that handle USB isolation.

- [ ] **Step 2: Confirm the real-USB-leak error pattern**

Run: `cd apps/desktop && .venv.win/Scripts/python.exe -m pytest tests/test_device_reset.py::test_device_reset_functionality --no-header -q --tb=line 2>&1 | grep -E "Could not initialize|VID=" | head -3`
Expected: `ERROR: Could not initialize USB backend` or `VID=0x10d6, PID=0xaf0c not found.`

- [ ] **Step 3: Add a `mock_usb_backend` autouse fixture to conftest.py**

In `apps/desktop/tests/conftest.py`, add (or extend the existing autouse fixture) a USB-backend mock. The cleanest approach is to patch `usb.core.find` and `usb.backend.libusb1.get_backend` for the duration of the test:

```python
@pytest.fixture(autouse=True)
def mock_usb_backend(request):
    """Mock libusb backend for tests that exercise device-connect paths.

    Without this, tests that call Jensen.connect or desktop_device_adapter.connect
    end up trying to enumerate real USB devices, which fails on a workstation
    without HiDock hardware ('Could not initialize USB backend' / 'VID not found').
    Applies autouse to test files in the E1 cluster; other tests are unaffected
    because they don't call USB-touching code.
    """
    if not any(
        name in request.node.nodeid
        for name in (
            "test_device_reset",
            "test_connection_recovery_integration",
        )
    ):
        yield
        return

    with patch("usb.core.find", return_value=None), patch(
        "usb.backend.libusb1.get_backend", return_value=None
    ):
        yield
```

(Verify the exact patch targets by grepping `apps/desktop/src` for `usb.core` and `usb.backend`. If those exact paths aren't used, use the paths the production code actually imports.)

- [ ] **Step 4: Run the 5 E1 tests**

Run: `cd apps/desktop && .venv.win/Scripts/python.exe -m pytest tests/test_device_reset.py tests/test_device_reset_simple.py tests/test_connection_recovery_integration.py --no-header -q`
Expected: All previously failing tests now pass. (E4's async marker fix from Task 2 is also a prerequisite — make sure Task 2 is committed first.)

- [ ] **Step 5: Run the full desktop sweep to confirm zero regressions**

Run: `cd apps/desktop && .venv.win/Scripts/python.exe -m pytest --no-header -q --ignore=tests/test_hidock_device_file_operations.py --ignore=tests/test_hidock_device_connection.py 2>&1 | tail -3`
Expected: Failed count is at or below the 74 baseline from phase-2 (we want 13 fewer failures, ending around 61). The exact number depends on whether E4's marker also unlocked other tests in the same file.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/rcox/hidock-tools/hidock-next
git add apps/desktop/tests/conftest.py apps/desktop/tests/test_device_reset.py apps/desktop/tests/test_device_reset_simple.py apps/desktop/tests/test_connection_recovery_integration.py
git commit -m "fix(tests): Family E1 — mock libusb backend for device_reset + connection_recovery tests

The phase-2 conftest (864a9f87) added config_path + GUI isolation but not USB
isolation. The E1 test files (test_device_reset, test_device_reset_simple,
test_connection_recovery_integration) call Jensen.connect and end up
exercising the real libusb-1.0.dll backend, failing on workstations
without HiDock hardware.

Added an autouse mock_usb_backend fixture in conftest.py that patches
usb.core.find and usb.backend.libusb1.get_backend for the affected test
files. Other tests are untouched (the fixture is a no-op unless the test
nodeid matches an E1 file)."
```

---

## Task 6: Verify the full desktop sweep

- [ ] **Step 1: Run the full desktop sweep**

Run: `cd apps/desktop && .venv.win/Scripts/python.exe -m pytest --no-header -q --ignore=tests/test_hidock_device_file_operations.py --ignore=tests/test_hidock_device_connection.py 2>&1 | tail -3`
Expected: Failed count is 74 − 13 = 61 (or possibly 60 if E4's marker also resolved a related failure). Pass count goes up by at least 13.

- [ ] **Step 2: Confirm no regressions in any previously-passing phase-2 file**

Run: `cd apps/desktop && .venv.win/Scripts/python.exe -m pytest tests/test_config_and_logger.py tests/test_config_and_logger_coverage.py tests/test_desktop_device_adapter_comprehensive.py tests/test_file_status_and_api_key_fixes.py tests/test_high_impact_coverage.py tests/test_version.py --no-header -q 2>&1 | tail -3`
Expected: 0 failures, all previously-green tests still green.

- [ ] **Step 3: Update the readiness memory file**

Edit `~/.claude/projects/C--Users-rcox-hidock-tools-hidock-next/memory/2026-06-06-primetime-readiness-state.md`:

In the "Family E" line, change:
> E. Small one-offs — 12 fails ... **— PENDING**

to:
> E. Small one-offs — 0 fails (was 13 at start of slice, all resolved in 5 commit tasks) **— DONE (commit FAMILY-E1 ... FAMILY-E5, or single combined commit if squashed)**

Add a final section noting the /goal progress: 13 fewer failures, 5 new commits local, no push.

- [ ] **Step 4: Report final status to the user**

Summarize:
- Family E: 13/13 fixed across 5 commits (Task 1–5) + 1 verification commit (Task 6)
- Desktop baseline: 74 → 61 failed (or lower)
- All 5 commits local, no push
- Remaining work for the /goal: Family A (40), Family B (22), 2 hung files, 9 JS projects npm install, Phase 7 spec, coverage gate
