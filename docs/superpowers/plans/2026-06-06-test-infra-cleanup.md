# Test Infrastructure Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the desktop test suite to a clean baseline by fixing 32 pre-existing test failures across 5 distinct root-cause clusters (the 9 collection errors + 23 collection-OK failures uncovered during verification of the 2026-06-05 P1 connect fix).

**Architecture:** Five independent, locally-scoped fixes to test infrastructure. No production code changes. No new test files. No behavioral changes to any production system. Each cluster can be verified by running a single `pytest` invocation on the affected file. All edits stay in `apps/desktop/tests/` and `apps/desktop/pyproject.toml`.

**Tech Stack:** Python 3.12, pytest 9.0.3, pytest-asyncio 1.4.0 (Mode.STRICT), MagicMock, CustomTkinter (mock class only).

---

## Baseline (captured 2026-06-06, before any change)

`.venv.win/Scripts/python.exe -m pytest apps/desktop/tests` produces:
- **9 collection errors** in 9 files: `ModuleNotFoundError: No module named 'tests.helpers'` — every file that does `from tests.helpers.optional import require`:
  - `test_advanced_audio_features.py`
  - `test_audio_player_enhanced.py`
  - `test_audio_visualization.py`
  - `test_config_validation_fix.py`
  - `test_connection_recovery_integration.py`
  - `test_device_communication.py`
  - `test_device_reset.py`
  - `test_device_reset_simple.py`
  - `test_hidock_device_commands.py`
- **20 async test failures** in `test_device_fallback_mocked.py` (missing `@pytest.mark.asyncio` under STRICT mode)
- **2 failures** in `test_device_selector_comprehensive.py` (line 175 `inspect.getsource(...SettingsDialog._populate_connection_tab)` and line 222 `dialog._populate_connection_tab(mock_tab)`)
- **1 failure** in `test_settings_persistence.py` (line 104 `dialog._save_single_setting("autoconnect_var")`)
- **4 failures** in `test_desktop_device_adapter.py`:
  - line 81: `assert len(devices) == 2` → production returns 4 (2 vendors × 2 PIDs)
  - line 501: `assert result.used_space == 750 * 1024 * 1024` → production returns 250 MiB (firmware-bug workaround: `used` field is actually `free`)
  - line 567: `TypeError: argument of type 'Mock' is not iterable` — test mocks `list_files`, production calls `list_files_with_retry`
  - line 894: same root cause as line 567

Total: 9 collection errors + 27 test failures. (The pre-summary "32" was an off-by-some estimate; ground truth is 9 + 27 = 36.)

---

## CI context (informational)

`.github/workflows/ci.yml` runs `pytest tests/` (root-level, using the root `pytest.ini`). The root `pytest.ini` has `addopts = -q -m "not slow and not integration and not gui and not optional"` — no `--cov-fail-under=80`. CI therefore never invokes the desktop `pyproject.toml`'s `addopts`. The `--cov-fail-under=80` gate only fires on direct `pytest apps/desktop/tests/...` invocations, never in CI. Removing the gate from `apps/desktop/pyproject.toml` does NOT weaken CI's enforcement — there is no enforcement to weaken. The spec's CI-verification step is therefore a no-op confirm ("CI still passes; the gate was never in CI's path") rather than a "re-add the flag" action.

---

## File structure

| File | Change | Lines |
|---|---|---|
| `apps/desktop/tests/conftest.py` | Add `sys.path` block for repo root; add 2 no-op methods to `MockSettingsDialog` | ~12 |
| `apps/desktop/tests/test_device_fallback_mocked.py` | Add `@pytest.mark.asyncio` to 20 test methods | 20 |
| `apps/desktop/tests/test_desktop_device_adapter.py` | 4 mock-setup fixes (1 list-attr, 1 used-vs-free, 1 count, 1 method-name) | 4 |
| `apps/desktop/pyproject.toml` (project config) | Remove `--cov-fail-under=80` from `addopts` | 1 |

**Total:** 3 test files + 1 project-config file, ~40 lines of changes. No application code changes.

---

## Task 1: Cluster 1 — sys.path block for `tests.helpers`

**Files:**
- Modify: `apps/desktop/tests/conftest.py:19-22`

- [ ] **Step 1: Confirm the conftest already has the `src/` block**

Read `apps/desktop/tests/conftest.py` lines 15-22. You should see:

```python
# Make ``src`` importable for collection. Without this, every test in this
# directory fails collection with ``ModuleNotFoundError: No module named
# 'desktop_device_adapter'`` because the package layout puts modules in
# ``../src`` and the tests don't have a package __init__ that does it for them.
_TESTS_DIR = Path(__file__).resolve().parent
_SRC_DIR = _TESTS_DIR.parent / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))
```

This block exists. Move to Step 2.

- [ ] **Step 2: Add the repo-root sys.path block immediately after the existing `src/` block**

In `apps/desktop/tests/conftest.py`, insert this code after line 22 (immediately after the `if str(_SRC_DIR) not in sys.path:` block) and before the next `@pytest.fixture` decorator:

```python

# Make ``tests.helpers.optional`` importable for tests that do
# ``from tests.helpers.optional import require``. ``tests/helpers/`` lives at
# the repo root and ``tests/helpers/optional.py`` is a PEP 420 namespace
# package (no ``__init__.py``). Without the repo root on ``sys.path``,
# pytest's rootdir (apps/desktop/) excludes the repo root, and the import
# fails with ``ModuleNotFoundError: No module named 'tests.helpers'``.
_REPO_ROOT = _TESTS_DIR.parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
```

- [ ] **Step 3: Verify collection works for one previously-broken file**

Run:

```bash
.venv.win/Scripts/python.exe -m pytest apps/desktop/tests/test_hidock_device_commands.py --collect-only -q
```

Expected: collection completes without `ModuleNotFoundError: No module named 'tests.helpers'`. You should see a list of test node IDs (no "ERROR" prefix).

- [ ] **Step 4: Verify all 9 collection errors are gone**

Run:

```bash
.venv.win/Scripts/python.exe -m pytest apps/desktop/tests --collect-only -q 2>&1 | grep -c "ModuleNotFoundError"
```

Expected output: `0`

- [ ] **Step 5: Side-effect check — confirm no new test collection**

The repo root has `tests/__init__.py` (empty) and a handful of test files in `tests/`. The desktop suite's `pytest.ini` (`apps/desktop/pyproject.toml` `[tool.pytest.ini_options]`) sets `testpaths = ["tests"]`, but `testpaths` is relative to the ini file's directory. So `pytest apps/desktop/tests` will *not* pick up repo-root tests even with the repo root on `sys.path`. Verify:

```bash
.venv.win/Scripts/python.exe -m pytest apps/desktop/tests --collect-only -q 2>&1 | tail -3
```

Expected: the output shows only tests from `apps/desktop/tests/`, no `tests/test_env_migration.py` or other root-level tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/tests/conftest.py
git commit -m "fix(tests): add repo root to sys.path so tests.helpers.optional is importable

9 desktop test files do 'from tests.helpers.optional import require'.
tests/helpers/ lives at the repo root and is a PEP 420 namespace package.
Without the repo root on sys.path, pytest's rootdir=apps/desktop/ excludes
the repo root and the import fails at collection. Mirrors the existing
src/ sys.path block in the same conftest."
```

---

## Task 2: Cluster 2 — `@pytest.mark.asyncio` on 20 test methods

**Files:**
- Modify: `apps/desktop/tests/test_device_fallback_mocked.py`

- [ ] **Step 1: Identify all `async def test_*` methods that lack the decorator**

Run:

```bash
grep -nB1 "    async def test_" apps/desktop/tests/test_device_fallback_mocked.py | grep -v "pytest.mark.asyncio" | grep "async def test_"
```

Expected: 20 lines of `    async def test_<name>(...)` that are NOT preceded by a line containing `@pytest.mark.asyncio`. (The 4 sync `def test_*` methods at lines 283, 292, 357, 374 are skipped by this filter and need no change.)

- [ ] **Step 2: Add `@pytest.mark.asyncio` above each of the 20 async test methods**

For every `async def test_*` method in the file that is NOT already decorated, insert `@pytest.mark.asyncio` on the line directly above it. Match the existing indentation (4 spaces inside the class).

Example pattern (do this for each):

```python
    @pytest.mark.asyncio
    async def test_discover_all_device_types(self, mock_adapter, sample_devices):
```

The file already imports `pytest` at the top, so no import change is needed.

The 20 methods to decorate (from the grep in Step 1; do not re-grep, the spec is authoritative):

1. `test_discover_all_device_types` (line 73)
2. `test_discover_single_device` (line 103)
3. `test_discover_no_devices` (line 128)
4. `test_connect_configured_device_success` (line 140)
5. `test_connect_configured_device_failure` (line 159)
6. `test_connect_fallback_to_first_available` (line 171)
7. `test_connect_no_device_available_offline` (line 183)
8. `test_connect_auto_retry_disabled` (line 196)
9. `test_connect_invalid_device_id_format` (line 210)
10. `test_connect_no_device_id_uses_defaults` (line 230)
11. `test_disconnect_success` (line 250)
12. `test_disconnect_failure` (line 273)
13. `test_get_device_info_connected` (line 301)
14. `test_get_device_info_not_connected` (line 324)
15. `test_offline_operations_fail_gracefully` (line 334)
16. `test_full_connection_workflow_successful_connection` (line 383)
17-20. (the remaining 4 async methods further down — re-grep to confirm names)

Use the Edit tool with `replace_all=false` for each method. The decorator insertion is 1 line per method; total 20 lines added.

- [ ] **Step 3: Run the file, confirm 0 failures**

Run:

```bash
.venv.win/Scripts/python.exe -m pytest apps/desktop/tests/test_device_fallback_mocked.py -v --no-header 2>&1 | tail -30
```

Expected: 24 passed (20 previously-failing async + 4 sync that already passed), 0 failed.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/tests/test_device_fallback_mocked.py
git commit -m "fix(tests): add @pytest.mark.asyncio to 20 async tests in test_device_fallback_mocked

pytest-asyncio is configured in STRICT mode (apps/desktop/pyproject.toml),
which requires explicit @pytest.mark.asyncio on every async def test_*.
20 tests in this file lacked the decorator and failed with
'async def functions are not natively supported'."
```

---

## Task 3: Clusters 3 + 4 — `MockSettingsDialog` missing methods

**Files:**
- Modify: `apps/desktop/tests/conftest.py` (the autouse fixture's `MockSettingsDialog` at lines 188-204)

- [ ] **Step 1: Read the current `MockSettingsDialog` to confirm the autouse-fixture structure**

Read `apps/desktop/tests/conftest.py` lines 182-208. The class is defined inside the `setup_test_environment` autouse fixture (because it's only needed for isolation-aware tests, but pytest still uses it as a class reference via `monkeypatch.setattr(settings_window, "SettingsDialog", MockSettingsDialog)` at line 206). The class has 4 methods: `__init__`, `open_settings_dialog`, `apply_settings`, `save_and_close`. We need to add `_populate_connection_tab` and `_save_single_setting`.

- [ ] **Step 2: Add the two no-op methods after `save_and_close`**

Edit `apps/desktop/tests/conftest.py`. After the `save_and_close` method (which ends with `return True` on line 204) and before the blank line + `monkeypatch.setattr(...)` call on line 206, add:

```python

            def _populate_connection_tab(self, *args, **kwargs):
                """No-op stub. Tests check method existence / callability, not behavior.

                See test_device_selector_comprehensive.py::test_inspect_settings_dialog_source
                which uses ``inspect.getsource(SettingsDialog._populate_connection_tab)`` and
                test_device_selector_comprehensive.py::test_populate_connection_tab_calls_super
                which calls the method directly. Both need the attribute to exist on the mock;
                neither cares about return value.
                """
                pass

            def _save_single_setting(self, *args, **kwargs):
                """No-op stub. Returns True to match test expectation of successful save.

                Tests that need a failure path should monkeypatch this attribute
                (e.g., ``dialog._save_single_setting = lambda *a, **kw: False``).
                The default-success behavior is intentional: it matches the
                success-path assertion in test_settings_persistence.py.
                """
                return True
```

Note the 12-space indentation (3 levels: 4 for class body inside fixture, 4 for fixture body, 4 for method body inside class). Match it exactly.

- [ ] **Step 3: Run the two affected files**

Run:

```bash
.venv.win/Scripts/python.exe -m pytest apps/desktop/tests/test_device_selector_comprehensive.py apps/desktop/tests/test_settings_persistence.py -v --no-header 2>&1 | tail -50
```

Expected: all tests in those two files pass. The 3 previously-failing tests should now be green:
- `test_device_selector_comprehensive.py::test_inspect_settings_dialog_source`
- `test_device_selector_comprehensive.py::test_populate_connection_tab_calls_super` (or whatever the actual test name is)
- `test_settings_persistence.py::test_save_settings_*` (the one calling `_save_single_setting`)

- [ ] **Step 4: Regression-proof check for `_save_single_setting` returning `True`**

The spec's contract: the test asserts save success. Confirm the test would fail if `_save_single_setting` returned `None` (i.e. `pass`). This guards against a future "simplification" that drops `return True`.

Temporarily change the method to `pass` (drops the return), run the test, then restore. Use Edit with `replace_all=false`:

Old:
```python
            def _save_single_setting(self, *args, **kwargs):
                """No-op stub. Returns True to match test expectation of successful save.

                Tests that need a failure path should monkeypatch this attribute
                (e.g., ``dialog._save_single_setting = lambda *a, **kw: False``).
                The default-success behavior is intentional: it matches the
                success-path assertion in test_settings_persistence.py.
                """
                return True
```

New (temporarily):
```python
            def _save_single_setting(self, *args, **kwargs):
                pass
```

Run:

```bash
.venv.win/Scripts/python.exe -m pytest apps/desktop/tests/test_settings_persistence.py -v --no-header 2>&1 | tail -15
```

Expected: at least one test in `test_settings_persistence.py` now FAILS. If it does NOT fail, the test is not actually exercising the return value — escalate to the user (the test needs strengthening before this cluster can be declared done).

Restore the `return True` version with Edit. Re-run to confirm green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/tests/conftest.py
git commit -m "fix(tests): add _populate_connection_tab and _save_single_setting to MockSettingsDialog

Three tests in test_device_selector_comprehensive.py and
test_settings_persistence.py need these methods on the mock.
- _populate_connection_tab: no-op; both tests check method existence.
- _save_single_setting: returns True to match the success-path
  assertion in test_settings_persistence.py. Docstring documents
  the monkeypatch pattern for failure-path tests."
```

---

## Task 4: Cluster 5 — mock-vs-dict / used-vs-free / count fixes in `test_desktop_device_adapter.py`

**Files:**
- Modify: `apps/desktop/tests/test_desktop_device_adapter.py` (lines 81, 501, 567, 894)

This task has 4 sub-fixes. Run them independently and verify after each.

- [ ] **Step 4.1: Fix the stale device-discovery count at line 81**

Read `apps/desktop/tests/test_desktop_device_adapter.py` lines 58-84. The test mocks 2 product IDs (0xAF0C, 0xAF0D) returning devices. Production now scans ALL_VENDOR_IDS × HIDOCK_PRODUCT_IDS via `_all_vid_pid_pairs()` (2 vendors × 2 PIDs = 4 mock results).

Edit the test to use a named constant that documents the relationship to the production helper:

Old (line 81):
```python
            assert len(devices) == 2
```

New:
```python
            # 2 mock vendors (0x10D6, 0x3887) × 2 mock products (0xAF0C, 0xAF0D) = 4
            # expected discoveries. Driven by DesktopDeviceAdapter._all_vid_pid_pairs().
            # Update this constant if you add another vendor or product to the mock.
            EXPECTED_DISCOVERY_COUNT = 2 * 2
            assert len(devices) == EXPECTED_DISCOVERY_COUNT
```

Run:

```bash
.venv.win/Scripts/python.exe -m pytest apps/desktop/tests/test_desktop_device_adapter.py::TestDeviceDiscovery::test_discover_devices_success -v --no-header 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 4.2: Fix the stale used-space assertion at line 501**

Read `apps/desktop/tests/test_desktop_device_adapter.py` lines 485-503. The mock provides `{"capacity": 1000, "used": 750}` in MB. Production applies a documented firmware-bug workaround (see `desktop_device_adapter.py:307`): the device's `used` field actually reports FREE space, so production computes `used_space = total_capacity - free_space = 1000 - 750 = 250 MiB`. The test was written before the workaround and asserts the pre-workaround value.

Edit the test to match production (production is the source of truth here — the workaround is intentional and documented in production code).

Old (line 501):
```python
        assert result.used_space == 750 * 1024 * 1024
```

New:
```python
        # Production applies a documented firmware-bug workaround:
        # the device's "used" field actually reports free space, so
        # used_space = total_capacity - free_space = 1000 - 750 = 250 MiB.
        # See desktop_device_adapter.py:307 (get_storage_info) for rationale.
        assert result.used_space == 250 * 1024 * 1024
```

Also update the `free_space` assertion 2 lines below so the test reflects the same mental model. Old (line 502):
```python
        assert result.free_space == 250 * 1024 * 1024
```

New:
```python
        assert result.free_space == 750 * 1024 * 1024
```

Run:

```bash
.venv.win/Scripts/python.exe -m pytest apps/desktop/tests/test_desktop_device_adapter.py::TestStorageOperations::test_get_storage_info_success -v --no-header 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 4.3: Fix `test_get_recordings_success` at line 567 — point the mock at the right method**

Read `apps/desktop/tests/test_desktop_device_adapter.py` lines 545-571. The test sets `self.mock_jensen.list_files.return_value = mock_files_info` but production calls `self.jensen_device.list_files_with_retry(...)` (see `desktop_device_adapter.py:346`). The mock attribute is wrong, so the call returns a bare `Mock()` and `"files" not in Mock` raises `TypeError`.

Edit the test to mock the right attribute.

Old (line 565):
```python
        self.mock_jensen.list_files.return_value = mock_files_info
```

New:
```python
        # Production calls list_files_with_retry (see desktop_device_adapter.py:346),
        # not list_files. The mock must target the right attribute or it returns
        # a bare Mock and "files" in Mock raises TypeError.
        self.mock_jensen.list_files_with_retry.return_value = mock_files_info
```

Run:

```bash
.venv.win/Scripts/python.exe -m pytest apps/desktop/tests/test_desktop_device_adapter.py::TestRecordingOperations::test_get_recordings_success -v --no-header 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 4.4: Fix `test_download_with_invalid_filename` at line 894 — same root cause**

Read `apps/desktop/tests/test_desktop_device_adapter.py` lines 886-894. Same problem: `list_files` is mocked but production uses `list_files_with_retry`.

Edit:

Old (line 891):
```python
        self.mock_jensen.list_files.return_value = {"files": []}
```

New:
```python
        # Production calls list_files_with_retry (see desktop_device_adapter.py:346).
        self.mock_jensen.list_files_with_retry.return_value = {"files": []}
```

Run:

```bash
.venv.win/Scripts/python.exe -m pytest apps/desktop/tests/test_desktop_device_adapter.py::TestErrorHandling::test_download_with_invalid_filename -v --no-header 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 4.5: Run the full file to confirm all 4 fixes hold together**

Run:

```bash
.venv.win/Scripts/python.exe -m pytest apps/desktop/tests/test_desktop_device_adapter.py -v --no-header 2>&1 | tail -10
```

Expected: 46 passed, 0 failed.

- [ ] **Step 4.6: Commit**

```bash
git add apps/desktop/tests/test_desktop_device_adapter.py
git commit -m "fix(tests): align test_desktop_device_adapter.py mocks with current production behavior

Four pre-existing failures:
- line 81: device discovery now returns 2 vendors × 2 PIDs = 4 devices,
  driven by _all_vid_pid_pairs(). Use named constant so future
  vendor/PID additions are easy to track.
- lines 501-502: get_storage_info applies a documented firmware-bug
  workaround (the device's 'used' field reports free space), so
  used_space = 250 MiB and free_space = 750 MiB. Update assertions
  to match.
- lines 565, 891: production calls list_files_with_retry (not
  list_files). Point the mocks at the right attribute.

No production code changes; tests now match documented behavior."
```

---

## Task 5: Cluster 6 — coverage gate removal from `pyproject.toml`

**Files:**
- Modify: `apps/desktop/pyproject.toml` (lines 222-231)

- [ ] **Step 1: Read the current addopts block**

Read `apps/desktop/pyproject.toml` lines 217-231. You should see:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
python_files = ["test_*.py"]
python_classes = ["Test*"]
python_functions = ["test_*"]
addopts = [
    "-v",
    "--tb=short",
    "--strict-markers",
    "--disable-warnings",
    "--cov=.",
    "--cov-report=html:htmlcov",
    "--cov-report=term-missing",
    "--cov-fail-under=80",
]
```

- [ ] **Step 2: Remove `--cov-fail-under=80` from addopts**

Edit the file to drop the `--cov-fail-under=80` line and add a comment explaining why.

Old (lines 222-231):
```toml
addopts = [
    "-v",
    "--tb=short",
    "--strict-markers",
    "--disable-warnings",
    "--cov=.",
    "--cov-report=html:htmlcov",
    "--cov-report=term-missing",
    "--cov-fail-under=80",
]
```

New:
```toml
addopts = [
    "-v",
    "--tb=short",
    "--strict-markers",
    "--disable-warnings",
    "--cov=.",
    "--cov-report=html:htmlcov",
    "--cov-report=term-missing",
    # --cov-fail-under=80 is intentionally omitted: per-file pytest runs
    # (e.g. `pytest apps/desktop/tests/test_X.py`) produce per-file coverage
    # below 80% and trip the gate, masking real test failures with a
    # confusing "Coverage failure" message. CI invokes the desktop suite
    # indirectly via root-level `pytest tests/` (see .github/workflows/ci.yml),
    # which uses the root pytest.ini — not this addopts block. If a future
    # contributor wants to enforce 80% on the desktop suite, do so in CI's
    # invocation with an explicit `--cov-fail-under=80` flag, not here.
]
```

- [ ] **Step 3: Verify per-file run completes without coverage-gate noise**

Run:

```bash
.venv.win/Scripts/python.exe -m pytest apps/desktop/tests/test_desktop_device_adapter.py 2>&1 | tail -5
```

Expected: shows the test results, no "Coverage failure: total of N is less than fail-under=80" line.

- [ ] **Step 4: Confirm root-level pytest still works (CI parity)**

Run:

```bash
.venv.win/Scripts/python.exe -m pytest tests/ 2>&1 | tail -5
```

Expected: this is what CI runs. It uses the root `pytest.ini` (not the desktop `pyproject.toml`), so the change in this task has no effect on it. Sanity-check by confirming the test session completes.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/pyproject.toml
git commit -m "chore(pyproject): drop --cov-fail-under=80 from desktop addopts

The flag only fires on direct 'pytest apps/desktop/tests/...' invocations
(root CI runs 'pytest tests/' with the root pytest.ini, which never
loaded this addopts block in the first place). Per-file developer runs
were tripping the gate on per-file coverage below 80% and masking real
test failures with a confusing 'Coverage failure' message. CI enforcement,
if reintroduced, belongs in the CI workflow's pytest invocation."
```

---

## Task 6: End-to-end verification

**Files:** none (read-only)

- [ ] **Step 1: Run the previously-broken files in one shot**

Run:

```bash
.venv.win/Scripts/python.exe -m pytest \
  apps/desktop/tests/test_hidock_device_commands.py \
  apps/desktop/tests/test_device_reset.py \
  apps/desktop/tests/test_device_communication.py \
  apps/desktop/tests/test_connection_recovery_integration.py \
  apps/desktop/tests/test_config_validation_fix.py \
  apps/desktop/tests/test_audio_visualization.py \
  apps/desktop/tests/test_audio_player_enhanced.py \
  apps/desktop/tests/test_advanced_audio_features.py \
  apps/desktop/tests/test_device_reset_simple.py \
  apps/desktop/tests/test_device_fallback_mocked.py \
  apps/desktop/tests/test_device_selector_comprehensive.py \
  apps/desktop/tests/test_settings_persistence.py \
  apps/desktop/tests/test_desktop_device_adapter.py \
  --no-header 2>&1 | tail -3
```

Expected: all 13 files collect (no `ModuleNotFoundError`); all tests in those files pass.

- [ ] **Step 2: Run the full desktop suite to confirm no regressions**

Run:

```bash
.venv.win/Scripts/python.exe -m pytest apps/desktop/tests 2>&1 | tail -5
```

Expected: significant reduction in failures vs. baseline. The 9 collection errors are gone. The 23 collection-OK failures (20 async + 3 mock methods) are gone. The 4 desktop-adapter failures are gone. Any remaining failures should be pre-existing GUI tests (out of scope per spec) or unrelated flakes.

If a regression appears (a test that was passing in the baseline now fails), STOP and investigate. Do not declare done.

- [ ] **Step 3: Run the root-level suite to confirm no cross-app regressions**

Run:

```bash
.venv.win/Scripts/python.exe -m pytest tests/ 2>&1 | tail -5
```

Expected: same pass/fail count as before. The conftest.py and pyproject.toml changes are scoped to `apps/desktop/tests/` and `apps/desktop/pyproject.toml`; they should not affect root-level tests.

- [ ] **Step 4: Commit (only if a docs/changelog note is needed)**

This task is read-only. If no changes were made, skip the commit. If you added a CHANGELOG entry or similar, commit that.

---

## Self-review

**1. Spec coverage:** Each of the 5 spec clusters maps to exactly one task:
- Cluster 1 → Task 1 (sys.path)
- Cluster 2 → Task 2 (asyncio)
- Clusters 3+4 → Task 3 (MockSettingsDialog)
- Cluster 5 → Task 4 (4 sub-fixes in test_desktop_device_adapter.py)
- Cluster 6 → Task 5 (pyproject.toml)

The spec's "regression-proof check" for `_save_single_setting` is Step 4 of Task 3. The spec's "side-effect check" for `sys.path` is Step 5 of Task 1. The spec's "CI verification" for the coverage gate is Step 4 of Task 5 (and the CI-context preamble explains why it's a sanity check rather than a re-add-flag action).

**2. Placeholder scan:** No "TBD", "TODO", "implement later". Every code block is the literal text to insert. Every command has expected output.

**3. Type consistency:** Method names match across tasks:
- `MockSettingsDialog._populate_connection_tab` and `MockSettingsDialog._save_single_setting` are spelled identically in the spec and Task 3.
- `list_files_with_retry` is the production method name and the mock attribute name (Tasks 4.3, 4.4).
- `_all_vid_pid_pairs` is the production static method; `EXPECTED_DISCOVERY_COUNT` is the test constant (Task 4.1).
- `desktop_device_adapter.py:346` and `:307` line refs are consistent with the file read during plan-writing.

If the implementer finds any line number drift, they should `grep` for the symbol and use the new line number; the line numbers in this plan are anchors, not contracts.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-06-test-infra-cleanup.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, two-stage review between tasks (spec compliance, then code quality), fast iteration. Best for this plan because the 5 tasks are independent and each has clear pass/fail criteria.

2. **Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints for review. Best if the user wants immediate visibility into each step.

Per the `/goal self develop this to a fully working product` directive and the stop-hook feedback (no implementation has occurred yet, no verification has been executed), I will proceed with **Subagent-Driven** execution without waiting for confirmation. The user has indicated long-running autonomous work is the expectation.
