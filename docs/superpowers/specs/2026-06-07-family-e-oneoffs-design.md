# Family E — Desktop Test One-Off Drift Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the 13 remaining pre-existing desktop test failures (Family E) that were deferred from the phase-2 plan because they didn't fit the C/D pattern.

**Architecture:** The phase-2 plan at `docs/superpowers/plans/2026-06-06-test-drift-cleanup-phase-2.md` explicitly scoped itself to Families C (config+logger) and D (comprehensive/parallel drift). Family E was identified but not closed. The 13 failures fall into 4 sub-clusters by root cause, not by file, so this spec is organized by sub-cluster rather than by file.

**Tech Stack:** Python 3.12, pytest 9.0.3, pytest-asyncio 1.4.0, unittest.mock, `apps/desktop` test suite (Windows-native PyUSB / libusb-1.0.dll).

**Constraints (preserved from prior sessions):**

- Do NOT push to git. Local commits only.
- USB safety rules from `CLAUDE.md` apply — these tests should be 100% mocked; do not "fix" failing tests by exercising real hardware.
- This spec targets the `/goal` slice: clearing the last batch of pre-existing test failures. It does not address JS projects, hung files, Electron, or coverage-gate restoration — those are separate slices.

---

## Sub-cluster map

| Sub-cluster | Failure count | Test files | Root cause |
|-------------|---------------|------------|------------|
| **E1. Real-USB leakage** | 5 | test_device_reset, test_device_reset_simple, test_connection_recovery_integration (1 of 2) | Tests still touch real `libusb-1.0.dll` because the libusb backend initialization in `conftest.py`/`DeviceTestManager` is not fully mocked. The test runner ends up trying to enumerate real USB devices and fails with "VID=0x10d6, PID=0xaf0c not found." |
| **E2. Contract drift — discovery & `auto_retry`** | 5 | test_device_fallback_mocked (5 tests) | (a) Production now discovers 2 vendor IDs per model (10d6 + 3887) — old test asserts 1. (b) `auto_retry` default flipped True→False. (c) `connect(no_device_id)` now iterates VID pairs and the first match is the H1 (af0c), not the H1E (b00d) the test was written against. |
| **E3. String/constants drift** | 2 | test_constants (1), test_usb_device_selection (1) | `constants.DEFAULT_PRODUCT_ID` is now `0xAF0C` (H1) — old test asserted `0xB00D` (H1E). `_get_hidock_model_name(0xAF0D)` now returns the real model name "H1E" — old test asserted the placeholder "Device". |
| **E4. Async marker missing** | 1 | test_connection_recovery_integration::test_connection_recovery_after_error | Function is `async def` but missing `@pytest.mark.asyncio` (pytest-asyncio 1.4.0 with `Mode.STRICT` requires the marker). Identical to phase-2 Cluster 2. |
| **E5. pydub mock leakage** | 1 | test_hta_converter::test_parse_hta_format_1_pydub_success | The test's `@patch` of `pydub.AudioSegment.from_mp3` is not intercepting because of an import-path mismatch (test patches the wrong reference). Result: real pydub receives the test bytes, fails with `'<=' not supported between instances of 'int' and 'Mock'`, and the test sees the original bytes back. |

> **Family E total: 13 failures across 5 sub-clusters** (the memory file `2026-06-06-primetime-readiness-state.md` reported 12; the +1 is E4, which is in fact a phase-2 Cluster-2-style fix that was missed during phase-2 audit because the file is mixed async/sync).

---

## Sub-cluster E1: Real-USB leakage (5 failures)

### Files to modify

- `apps/desktop/tests/conftest.py` — strengthen mock for USB backend initialization
- `apps/desktop/tests/test_device_reset.py` — 2 tests
- `apps/desktop/tests/test_device_reset_simple.py` — 1 test
- `apps/desktop/tests/test_connection_recovery_integration.py` — 1 test (the non-async one)

### Root cause

`DeviceTestManager` is a fixture in `conftest.py` that claims "exclusive access" for the test. The test files import and call its `start_exclusive_access` / `end_exclusive_access` methods, but inside that, they call `Jensen.connect(...)` or `desktop_device_adapter.connect(...)`, which then calls into the real `usb` / libusb backend. On a workstation without a real HiDock, this fails with "VID=0x10d6, PID=0xaf0c not found."

These tests were written before the conftest was hardened. The phase-2 conftest change (commit `864a9f87`) added an autouse `setup_test_environment` fixture that handles `_CONFIG_FILE_PATH` and the GUI module imports, but did **not** add a USB-backend mock. As a result, every test in `test_device_reset*` and `test_connection_recovery_integration` that calls `Jensen.connect` still touches real USB.

### Approach

Add an autouse fixture in `conftest.py` that, when a test calls any function with "device", "jensen", or "usb" in its name (or when the test is in one of the E1 files), patches `usb.core.find` and `usb.backend.libusb1.get_backend` to return `None`/empty.

Cleaner approach: add a fixture `mock_usb_backend` to `conftest.py` and mark the E1 tests with `@pytest.mark.usefixtures("mock_usb_backend")` (or apply the fixture autouse for those files via a per-file conftest or `pytest_collection_modifyitems`).

**Recommended:** Add an autouse fixture scoped to a `tests_e1` pytest marker. Tag the 4 E1 test files with `@pytest.mark.e1_mock_usb` (or simpler: use a single fixture in `conftest.py` that checks `request.node.nodeid` for the affected paths and applies the patch).

### Acceptance criteria

- 5 previously failing tests pass.
- No test in the desktop suite that previously passed starts failing.
- The `mock_usb_backend` fixture is documented inline (1–2 lines).

---

## Sub-cluster E2: Contract drift in `test_device_fallback_mocked.py` (5 failures)

### File to modify

- `apps/desktop/tests/test_device_fallback_mocked.py` — 5 tests

### Root cause

The `desktop_device_adapter.discover_all_devices()` method now iterates both vendor IDs (10d6 = Actions Semiconductor, 3887 = an alternate HiDock vendor ID — present in `constants.py` as `ACTIONS_SEMICONDUCTOR` and a second ID for some firmware variants). The test was written when only one VID was iterated. Additionally, `connect(no_device_id)` now returns the first available match (H1 = af0c), not the test-asserted H1E (b00d).

The `auto_retry=True` default in `Jensen.connect` was changed to `auto_retry=False` in the post-`fd1ca915` refactor. The tests assert `auto_retry=True` based on the old default.

### Approach

Update the 5 tests in `test_device_fallback_mocked.py` to reflect the current contract:

1. **`test_discover_all_device_types`** — assert `len(discovered) == 6` (or `>= 3` if you want to be robust to further additions). Document the 2-vendor-ID discovery in a comment.
2. **`test_discover_single_device`** — assert `len(discovered) == 2` for a single-model probe.
3. **`test_connect_configured_device_success`** — change `auto_retry=True` → `auto_retry=False`.
4. **`test_connect_invalid_device_id_format`** — change expected `pid=45069` → `pid=44812` (H1 is the first match), and `auto_retry=True` → `False`.
5. **`test_connect_no_device_id_uses_defaults`** — change `auto_retry=True` → `False`, and update the expected PID if it differs (verify by reading the test).

### Acceptance criteria

- 5 previously failing tests pass.
- Comments in each test call out the 5a3a9c9d / 938b7825 / fd1ca915 contract change that motivated the assertion update (this is the pattern established in phase-2 — see the test_config_and_logger_coverage.py docstrings as the template).

---

## Sub-cluster E3: String/constants drift (2 failures)

### Files to modify

- `apps/desktop/tests/test_constants.py` — 1 test
- `apps/desktop/tests/test_usb_device_selection.py` — 1 test

### Root cause

`constants.DEFAULT_PRODUCT_ID` was changed from `0xB00D` (H1E) to `0xAF0C` (H1) — likely because the desktop app's default connect target is the H1 (the most common model), not the H1E. The test was written against the old default.

`_get_hidock_model_name(0xAF0D)` in `enhanced_device_selector.py` now returns the real model name string `"H1E"` from a lookup table — the test was asserting the placeholder string `"Device"`.

### Approach

1. **`test_constants.py::test_usb_device_constants`** — update the assertion to `0xAF0C`. Add a comment explaining the post-refactor default is H1 (most common model).
2. **`test_usb_device_selection.py::test_hidock_model_names`** — update the assertion to `"H1E"`. Add a comment noting the placeholder "Device" was replaced with the real model name in the production lookup.

### Acceptance criteria

- 2 previously failing tests pass.

---

## Sub-cluster E4: Async marker missing (1 failure)

### File to modify

- `apps/desktop/tests/test_connection_recovery_integration.py` — 1 test

### Root cause

`test_connection_recovery_after_error` is an `async def` test. With pytest-asyncio 1.4.0 in `Mode.STRICT` (see `pytest.ini`), every async test must have `@pytest.mark.asyncio`. The phase-2 audit (`f63c3294`) added markers to 20 tests but missed this one because the file is mixed async/sync.

### Approach

Add the marker:
```python
@pytest.mark.asyncio
async def test_connection_recovery_after_error():
    ...
```

### Acceptance criteria

- The test passes (or fails for a *different*, real reason — which we then investigate).
- The fix matches the pattern in `f63c3294`.

---

## Sub-cluster E5: pydub mock leakage (1 failure)

### File to modify

- `apps/desktop/tests/test_hta_converter.py` — 1 test

### Root cause

`test_parse_hta_format_1_pydub_success` patches `pydub.AudioSegment.from_mp3` but the import path inside `hta_converter.py` is likely different (e.g., `from pydub import AudioSegment` vs. `import pydub.AudioSegment`). When the patch target doesn't match the lookup site, the real `pydub` is called, fails on the synthetic test bytes, and the test sees the original input echoed back.

### Approach

1. Read `hta_converter.py` to find the exact import used for `pydub`.
2. Update the `@patch` decorator in the test to target the right path.
3. If the import is `from pydub import AudioSegment` then `@patch("hta_converter.AudioSegment.from_mp3")` is the right target. If the import is `import pydub` then `@patch("pydub.AudioSegment.from_mp3")` is right.

### Acceptance criteria

- The test passes with the mock returning the configured value.
- The `@patch` target is the exact lookup path used by the production code.

---

## Out-of-scope (explicitly not addressed by this spec)

- **Family A (calendar, 40 fails)** — Windows-only, frozen in prior memory; needs its own brainstorm/spec/plan.
- **Family B (transcription, 22 fails)** — Out of phase-2 scope; needs its own brainstorm/spec/plan.
- **2 hung files** (`test_hidock_device_file_operations.py`, `test_hidock_device_connection.py`) — Separate investigation.
- **9 JS projects with no `node_modules`** — Separate `npm install` + Electron-verify slice.
- **Meeting-assistant Phase 7 spec** — Doesn't exist yet; needs its own brainstorm.
- **`--cov-fail-under=80` coverage gate** — Was removed in phase-2 Cluster 5; not restored in this spec.
- **E2E smoke tests** — Out of scope.

---

## Plan structure

This spec will be followed by `docs/superpowers/plans/2026-06-07-family-e-oneoffs.md`, organized as 5 tasks (one per sub-cluster) plus 1 verification task. Each task should be small enough to dispatch as a subagent.
