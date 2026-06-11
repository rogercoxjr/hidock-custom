# Test-Drift Cleanup Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve 29 pre-existing desktop test failures caused by tests written against older API after a major config & desktop_device_adapter refactor (commits 5a3a9c9d, 938b7825, fd1ca915).

**Architecture:** Pure test-code fixes (no production code changes) except where missing test-only attributes on `_version.py` need a one-line add. All fixes preserve current production behavior; tests are updated to match the refactored code.

**Tech Stack:** Python 3.12, pytest 9.0.3, pytest-asyncio 1.4.0, unittest.mock, customtkinter (mocked).

---

## Task 1: Add 2 missing methods to `MockSettingsDialog`

**Files:**
- Modify: `apps/desktop/tests/conftest.py:245-310` (MockSettingsDialog class)
- Test: `apps/desktop/tests/test_file_status_and_api_key_fixes.py` (validates the fix)

### Failure analysis
`test_file_status_and_api_key_fixes.py:190,162` call `settings_dialog._decrypt_api_key("...")` and get `AttributeError`. `test_file_status_and_api_key_fixes.py:221` calls `_load_api_key_status()`. Both methods exist on the REAL `SettingsDialog` (in `src/settings_window.py`), so the mock just needs to delegate to them. Pattern is identical to Cluster 3 fix for `_save_single_setting` / `_populate_connection_tab`.

### Steps

- [ ] **Step 1.1: Read the real `_decrypt_api_key` and `_load_api_key_status` signatures**

Run: `cd apps/desktop && grep -n "def _decrypt_api_key\|def _load_api_key_status" src/settings_window.py`

Expected: two method definitions with their full bodies.

- [ ] **Step 1.2: Add 2 methods to MockSettingsDialog**

In `apps/desktop/tests/conftest.py`, inside `MockSettingsDialog`, add after `_save_single_setting`:

```python
def _decrypt_api_key(self, encrypted_b64: str) -> str:
    """Decrypt an API key (mocked: delegate to real SettingsDialog).

    test_file_status_and_api_key_fixes.py::TestAPIKeyFixes constructs a real
    SettingsDialog via __new__ and calls _decrypt_api_key on the patched
    MockSettingsDialog. Patch the test's SettingsDialog references to the
    MockSettingsDialog class (it does this via ``with patch("settings_window.SettingsDialog")``),
    so this method runs INSTEAD of the real one.

    The mocked implementation routes through the real SettingsDialog to keep
    the production encryption/decryption contract intact, then returns
    whatever the real one returns. Tests assert on the side effects
    (decrypt called, file removed) not the return value.
    """
    import settings_window as _sw
    real = _sw.SettingsDialog.__new__(_sw.SettingsDialog)
    return real._decrypt_api_key(encrypted_b64)

def _load_api_key_status(self) -> None:
    """Load and display the API key status (mocked: delegate to real SettingsDialog).

    test_file_status_and_api_key_fixes.py::TestAPIKeyFixes::test_load_api_key_status_decryption_failure
    patches Fernet to raise, then calls this method. The mock must invoke the
    real implementation (which logs and updates local_vars) so the test's
    assertions on logger.info / local_vars[api_key_status_var] succeed.
    """
    import settings_window as _sw
    real = _sw.SettingsDialog.__new__(_sw.SettingsDialog)
    real.local_vars = self.local_vars
    return real._load_api_key_status()
```

- [ ] **Step 1.3: Run targeted tests**

Run: `cd apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_file_status_and_api_key_fixes.py --no-cov -v`

Expected: 3 previously-failing tests now pass; no new failures.

- [ ] **Step 1.4: Verify no regression in test_settings_persistence / test_device_selector_comprehensive**

Run: `cd apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_settings_persistence.py tests/test_device_selector_comprehensive.py --no-cov`

Expected: 28/28 pass (regression check for Cluster 3's mock methods).

---

## Task 2: Fix `ntpath.makedirs` patcher in `test_high_impact_coverage.py`

**Files:**
- Modify: `apps/desktop/tests/test_high_impact_coverage.py:145` (or wherever the makedirs patch is)
- Test: same file

### Failure analysis
`AttributeError: <module 'ntpath' (frozen)> does not have the attribute 'makedirs'` — test uses `patch("ntpath.makedirs")` but `ntpath` (the frozen Windows path module) doesn't have `makedirs`; `os.makedirs` is what should be patched. `makedirs` lives in `os` not `ntpath` (the latter is the *implementation* of `os.path`).

### Steps

- [ ] **Step 2.1: Find the patch location**

Run: `cd apps/desktop && grep -n "ntpath\|makedirs" tests/test_high_impact_coverage.py`

Expected: 1-2 lines using `ntpath.makedirs`.

- [ ] **Step 2.2: Replace `ntpath` with `os` in the patch target**

Change every `patch("ntpath.makedirs")` (or `patch.object(ntpath, "makedirs")`) to `patch("os.makedirs")`. `os.makedirs` is the public callable that `os.path.makedirs` ends up invoking on Windows.

- [ ] **Step 2.3: Run the file**

Run: `cd apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_high_impact_coverage.py --no-cov`

Expected: 1 more pass (out of 4 previously failing in this file).

---

## Task 3: Fix `simple_calendar_mixin` import error in `test_high_impact_coverage.py`

**Files:**
- Modify: `apps/desktop/tests/test_high_impact_coverage.py:145` (or wherever the import is)

### Failure analysis
`ModuleNotFoundError: No module named 'simple_calendar_mixin'` — the test imports a module that no longer exists (the `simple_calendar_mixin` was likely renamed or merged). Need to find the actual current location.

### Steps

- [ ] **Step 3.1: Find the import line**

Run: `cd apps/desktop && grep -n "simple_calendar_mixin" tests/test_high_impact_coverage.py`

- [ ] **Step 3.2: Find the actual module location in src/**

Run: `cd apps/desktop && ls src/ | grep -i calendar`

- [ ] **Step 3.3: Update the import to the real module name**

Replace the import with the current module name found in 3.2.

- [ ] **Step 3.4: Run the file**

Run: `cd apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_high_impact_coverage.py --no-cov`

Expected: 1 more pass.

---

## Task 4: Fix 3 `_version.py` test assertions in `test_version.py`

**Files:**
- Modify: `apps/desktop/tests/test_version.py` (3 tests)

### Failure analysis
- `test_all_exports`: expects `__version__...version_tuple` but gets `__version__...commit_id` — `_version.py` now exports `__commit_id__` and `commit_id` which weren't there before. Test was written against an older `_version.py` shape.
- `test_type_checking_behavior` and `test_type_checking_flag`: assert `_version.TYPE_CHECKING` exists. But `_version.py` is auto-generated by setuptools_scm and only contains version fields. The TYPE_CHECKING references in the test are vestigial from a different module.

### Steps

- [ ] **Step 4.1: Read test_version.py in full to see all TYPE_CHECKING and __all__ assertions**

Run: `cd apps/desktop && cat tests/test_version.py`

- [ ] **Step 4.2: For test_all_exports: add `commit_id` and `__commit_id__` to the expected list**

Find the line that checks `_version.__all__` (line ~65) and update the expected list to include the new fields.

- [ ] **Step 4.3: For test_type_checking_* tests: replace `TYPE_CHECKING` references with something the module actually has**

The test is checking that `TYPE_CHECKING` is a "False at runtime" flag. `_version.py` doesn't have it. Easiest fix: change the tests to assert on `version_tuple` or `commit_id` (which DO exist) and rename the test docstrings. Or remove the TYPE_CHECKING-specific tests entirely if their intent was already covered.

- [ ] **Step 4.4: Run test_version.py**

Run: `cd apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_version.py --no-cov -v`

Expected: 3 previously-failing tests now pass.

---

## Task 5: Fix 6 mock-vs-real-API bugs in `test_desktop_device_adapter_comprehensive.py`

**Files:**
- Modify: `apps/desktop/tests/test_desktop_device_adapter_comprehensive.py` (6 tests)

### Failure analysis
- 2 in `TestConnectionTimeoutAndRetry`: mocks set up wrong return values
- 1 in `TestRecordingOperationsEdgeCases::test_get_recordings_empty_files_info`: probably asserts on list_files_with_retry return but mock only sets list_files
- 1 in `TestRecordingOperationsEdgeCases::test_get_recordings_no_files_key`: same family
- 2 in `TestDeleteRecordingEdgeCases`: mocks set up wrong (delete_file, get_recordings, etc.)

Same family as Cluster 4 (production calls `list_files_with_retry` not `list_files`; production message changed from "Communication error" to "Delete failed").

### Steps

- [ ] **Step 5.1: List all 6 failures with line numbers and current test code**

Run: `cd apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_desktop_device_adapter_comprehensive.py --no-cov --tb=line 2>&1 | grep "FAILED\|tests\\\\test_desktop"`

- [ ] **Step 5.2: Read desktop_device_adapter.py to find current real method names and error messages**

Run: `cd apps/desktop && grep -n "def \|raise " src/desktop_device_adapter.py | head -40`

- [ ] **Step 5.3: For each of the 6 tests, fix mocks to match current API**

- `test_connect_timeout_retry_still_fails` and `test_connect_non_timeout_error_no_retry`: update mock setup to whatever the current `connect()` implementation expects.
- `test_get_recordings_empty_files_info` and `test_get_recordings_no_files_key`: change `mock_jensen.list_files.return_value` → `mock_jensen.list_files_with_retry.return_value`.
- `test_delete_recording_not_found` and `test_delete_recording_exception_handling`: update mocks to match current `delete_recording()` behavior (which now uses different error messages and may call `delete_file().get()` differently).

- [ ] **Step 5.4: Run test_desktop_device_adapter_comprehensive.py**

Run: `cd apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_desktop_device_adapter_comprehensive.py --no-cov`

Expected: 6 previously-failing tests now pass; 6 was the count of fails here, total now should be 0 in this file.

---

## Task 6: Fix 13 config-and-logger test issues across 2 files

**Files:**
- Modify: `apps/desktop/tests/test_config_and_logger.py` (1 test)
- Modify: `apps/desktop/tests/test_config_and_logger_coverage.py` (12 tests)

### Failure analysis
Three distinct issues:

1. **`HiDock_Downloads` rename** (test_config_and_logger.py:81): production changed default to `../audio`, test still expects `HiDock_Downloads`. Simple string update.

2. **`ImportError: cannot import name 'setup_logging'`** (3 tests in test_config_and_logger_coverage.py:195,208,...): production `config_and_logger.py` no longer exports `setup_logging`. Either the function was renamed, or tests need to call the replacement.

3. **Logger output assertions** (8+ tests): tests assert `logger.info` was called / `print` was not called, but the refactored logger uses different code paths. Either:
   - Tests need to assert on the new logger API
   - Or production logging was silenced in the refactor (test bug, update assertion)

### Steps

- [ ] **Step 6.1: Find current `setup_logging` replacement in production**

Run: `cd apps/desktop && grep -n "^def \|^class " src/config_and_logger.py | head -20`

- [ ] **Step 6.2: Update `test_get_default_config_download_directory_exists` assertion**

Change `assert "HiDock_Downloads" in config["download_directory"]` to `assert config["download_directory"].endswith("audio")` (or whatever the current default is).

- [ ] **Step 6.3: For the 3 `ImportError: setup_logging` tests: find what to import instead**

Read the test files around lines 195, 208, 315 and replace `from config_and_logger import setup_logging` with the actual current function name.

- [ ] **Step 6.4: For the 8 logger-assertion failures: inspect each one and update the mock target**

Run each failing test with `-v --tb=short` and fix the assertion or the mock target to match the current logger behavior. Common pattern: tests that assert `logger.info` was called may need to switch to `logger._setup_independent_levels` or whichever method the production code now uses.

- [ ] **Step 6.5: Run both files**

Run: `cd apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_config_and_logger.py tests/test_config_and_logger_coverage.py --no-cov`

Expected: 13 previously-failing tests now pass.

---

## Task 7: End-to-end verification of all 6 fix tasks

**Files:** none (verification only)

- [ ] **Step 7.1: Run all 6 plan-targeted test files**

Run: `cd apps/desktop && ./.venv.win/Scripts/python.exe -m pytest tests/test_file_status_and_api_key_fixes.py tests/test_high_impact_coverage.py tests/test_version.py tests/test_desktop_device_adapter_comprehensive.py tests/test_config_and_logger.py tests/test_config_and_logger_coverage.py --no-cov`

Expected: 0 failures, all green.

- [ ] **Step 7.2: Run the full desktop test suite (excluding 2 hung files) and confirm reduction**

Run: `cd apps/desktop && ./.venv.win/Scripts/python.exe -m pytest --no-cov --ignore=tests/test_hidock_device_file_operations.py --ignore=tests/test_hidock_device_connection.py --tb=no -q 2>&1 | tail -3`

Expected: failure count drops from 103 to ~74 (29 fewer). Other families (A=40, B=22, E=12) untouched and still failing.

- [ ] **Step 7.3: Commit locally (NO PUSH)**

Run:
```
cd C:/Users/rcox/hidock-tools/hidock-next
git add apps/desktop/tests/conftest.py \
        apps/desktop/tests/test_file_status_and_api_key_fixes.py \
        apps/desktop/tests/test_high_impact_coverage.py \
        apps/desktop/tests/test_version.py \
        apps/desktop/tests/test_desktop_device_adapter_comprehensive.py \
        apps/desktop/tests/test_config_and_logger.py \
        apps/desktop/tests/test_config_and_logger_coverage.py
git commit -m "fix(tests): resolve 29 test-drift failures from config + adapter refactor"
```

## Self-review
**1. Spec coverage:** Each of the 6 test failure families (MockSettingsDialog, ntpath, simple_calendar_mixin, _version, mock-vs-API, config) maps to exactly one task. Total: 1+1+1+3+6+13 = 25 of 29. The remaining 4 will surface as we work — investigate inside their respective task.

**2. Placeholder scan:** No "TBD" or "fill in details". Some steps require reading the current code first (e.g., "find the real module name") which is correct for a plan that fixes test drift.

**3. Type consistency:** MockSettingsDialog method names match the real `SettingsDialog` (verified by grep in Step 1.1). `list_files_with_retry` matches the production code (verified in Cluster 4 plan).
