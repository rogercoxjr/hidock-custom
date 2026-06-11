# HiDock P1 Connect Fix + Device Selector Crash Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add regression tests for the P1/0x3887 connect fix and the device selector crash, plus fix the test-path setup issue that blocks running `apps/desktop/tests/`.

**Architecture:** Three layers of work. (1) Lock in the previously-shipped code with unit tests so the next regression is caught at PR time, not on real hardware. (2) Fix the pre-existing test-path setup so the new tests (and every existing test in the directory) can actually be collected and run. (3) Update the design spec to record the post-implementation findings and ship the commit.

**Tech Stack:** Python 3.12, pytest, unittest.mock, PyUSB, CustomTkinter (mocked in tests).

**Pre-flight read (MANDATORY before any USB work):**
- `CLAUDE.md` (project root) — USB safety rules. **Test ALL USB code with mocks first — unit tests, never real hardware.**
- `docs/superpowers/specs/2026-06-05-hidock-p1-connect-fix-design.md` — the spec this plan implements against

**Code state (already shipped in working tree, not yet committed):**
- `apps/desktop/src/desktop_device_adapter.py` — 24-pair scan via `_all_vid_pid_pairs()`, `auto_retry=False` in adapter loop
- `apps/desktop/src/enhanced_device_selector.py` — line 421 `fg_color="transparent"` (replaces the buggy `None`)
- `apps/desktop/src/enhanced_device_selector.py` — `_is_hidock_device` accepts all `ALL_VENDOR_IDS × HIDOCK_PRODUCT_IDS`
- `apps/desktop/src/config_and_logger.py` — `target_interface` removed from defaults + validator
- `apps/desktop/src/gui_main_window.py` — `target_interface` removed
- `apps/desktop/src/settings_window.py` — `target_interface` removed
- `apps/web/src/adapters/webDeviceAdapter.ts` — uses `HIDOCK_VENDOR_IDS.includes(...)`
- `apps/web/src/services/deviceService.ts` — `isHiDockDevice` uses `HIDOCK_VENDOR_IDS.includes(...)`
- New tests (parse OK, can't run because of test-path issue):
  - `apps/desktop/tests/test_desktop_device_adapter.py` — 6 tests
  - `apps/desktop/tests/test_device_selector_comprehensive.py` — 7 tests (appended)
  - `apps/web/src/test/deviceService.test.ts` — 6 tests (web, syntax-only verified)
- `apps/desktop/config/hidock_config.json.example` — `target_interface` line removed
- 6 test/conftest files — `target_interface` references removed

---

## File Structure

| Path | Responsibility | Action |
|---|---|---|
| `apps/desktop/tests/conftest.py` | Add `src` to `sys.path` so all tests in directory can import | Modify |
| `apps/desktop/tests/test_desktop_device_adapter.py` | Lock in 24-pair scan, `auto_retry=False` behavior, `connect()` loop semantics | Already exists — verify it parses & is collectable |
| `apps/desktop/tests/test_device_selector_comprehensive.py` | Lock in `_is_hidock_device`, model-name resolution, **and the `fg_color=None` crash regression** | Modify (add selector crash regression test) |
| `docs/superpowers/specs/2026-06-05-hidock-p1-connect-fix-design.md` | Add §12 documenting post-implementation findings | Modify (spec update only — no code) |

No new files. The plan is **adoption + verification** of the already-shipped code, plus a targeted test for the selector crash bug.

---

## Task 1: Fix test-path setup so the new tests can run

**Files:**
- Modify: `apps/desktop/tests/conftest.py` (add a `sys.path` insertion near the top of the file)

This is the **pre-existing** issue called out in spec §10 follow-up #1. Every test file in `apps/desktop/tests/` fails collection with `ModuleNotFoundError: No module named 'desktop_device_adapter'`. The conftest does NOT add `apps/desktop/src` to `sys.path`. Fixing this unblocks all 70+ existing tests in that directory, not just the new ones.

The minimal change is to add `sys.path.insert(0, ...)` near the top of `conftest.py`, before the test-collection-time imports.

- [ ] **Step 1: Read `apps/desktop/tests/conftest.py` lines 1-15**

Confirm current top of file. (Already in context — first 10 lines are docstring + standard library imports + third-party imports + first fixture.)

- [ ] **Step 2: Add `sys.path` insertion after the docstring, before any project imports**

Edit `apps/desktop/tests/conftest.py`. Insert two lines after the opening `"""..."""` docstring and before the `import os` line:

```python
"""
Pytest configuration and fixtures for HiDock Next testing.
"""

import os
import sys
from pathlib import Path

# Make ``src`` importable for collection. Without this, every test in this
# directory fails collection with ``ModuleNotFoundError: No module named
# 'desktop_device_adapter'`` because the package layout puts modules in
# ``../src`` and the tests don't have a package __init__ that does it for them.
_TESTS_DIR = Path(__file__).resolve().parent
_SRC_DIR = _TESTS_DIR.parent / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))
```

Also remove the existing `import os` and `from pathlib import Path` lines (the new block imports them) — the file is short, so two duplicates are fine but cleaner to dedupe. Use `Edit` to remove the originals.

- [ ] **Step 3: Verify conftest still parses**

Run from repo root:

```bash
"C:\Users\rcox\hidock-tools\hidock-next\apps\desktop\.venv.win\Scripts\python.exe" -m py_compile "C:\Users\rcox\hidock-tools\hidock-next\apps\desktop\tests\conftest.py" && echo OK
```

Expected: `OK`

- [ ] **Step 4: Verify pytest can now collect the new test file**

Run from `apps/desktop/`:

```bash
cd "C:\Users\rcox\hidock-tools\hidock-next\apps\desktop" && "C:\Users\rcox\hidock-tools\hidock-next\apps\desktop\.venv.win\Scripts\python.exe" -m pytest tests/test_desktop_device_adapter.py --collect-only -q 2>&1 | head -20
```

Expected: At least 6 test items collected (e.g., `TestDesktopDeviceAdapter::test_all_vid_pid_pairs_includes_default_first`, etc.). If `ModuleNotFoundError`, the conftest fix is wrong.

- [ ] **Step 5: Run the new tests to confirm they pass**

Run from `apps/desktop/`:

```bash
cd "C:\Users\rcox\hidock-tools\hidock-next\apps\desktop" && "C:\Users\rcox\hidock-tools\hidock-next\apps\desktop\.venv.win\Scripts\python.exe" -m pytest tests/test_desktop_device_adapter.py -v 2>&1 | tail -30
```

Expected: All tests pass. (If any fail, do NOT commit — debug the failure before proceeding.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/tests/conftest.py
git commit -m "test(desktop): add src/ to sys.path so test collection works"
```

---

## Task 2: Add regression test for the device selector `fg_color=None` crash

**Files:**
- Modify: `apps/desktop/tests/test_device_selector_comprehensive.py` (append a new test class)

This test pins down the bug found in real-device testing on 2026-06-05. Before the fix, clicking a second device in the selector triggered `ValueError: color is None, for transparency set color='transparent'` at `enhanced_device_selector.py:421`. The fix replaces `None` with `"transparent"`. The test asserts the fix holds by:

1. Inspecting the source of `_select_device` and asserting the string `"transparent"` appears in the code (cheap regression guard)
2. (More rigorous) Constructing two `Mock` device buttons, calling `_select_device` with one, then calling it with the other, and asserting no `ValueError` is raised

Approach 2 is fragile (the test needs a half-instantiated frame hierarchy). Approach 1 is sufficient and matches the project's existing pattern (see `test_enhanced_device_selector_class_has_set_enabled_method` in the same file — uses `inspect` on source).

- [ ] **Step 1: Read the current end of `test_device_selector_comprehensive.py` to find a safe append point**

Run:

```bash
powershell -NoProfile -Command "Get-Content 'C:\Users\rcox\hidock-tools\hidock-next\apps\desktop\tests\test_device_selector_comprehensive.py' | Select-Object -Last 20"
```

Expected: end of the existing test class. We'll append a new test class after it.

- [ ] **Step 2: Append the regression test class**

Edit `apps/desktop/tests/test_device_selector_comprehensive.py`. Append (at the bottom of the file, after the existing `TestDeviceSelectorComprehensive` class):

```python
class TestDeviceSelectorSelectionReset:
    """Regression tests for the device selector crash on second selection.

    Bug found 2026-06-05 during real-device P1 Mini testing: clicking a
    second device in the EnhancedDeviceSelector raised
    ``ValueError: color is None, for transparency set color='transparent'``
    because the un-selected button was being reset with ``fg_color=None``
    and ``hover_color=None``. CustomTkinter requires explicit color values
    (use ``"transparent"`` to mean "theme default").

    Fixed in ``enhanced_device_selector.py`` by replacing ``None`` with
    ``"transparent"``. This test class pins the fix in place.
    """

    @pytest.mark.unit
    def test_select_device_unselect_path_uses_transparent_string(self):
        """The un-select branch in _select_device must not pass None to button.configure().

        Reading the source is a cheap, stable guard: it doesn't require
        instantiating a real CustomTkinter frame hierarchy.
        """
        import inspect

        source = inspect.getsource(enhanced_device_selector.EnhancedDeviceSelector._select_device)
        # The un-select branch should set fg_color/hover_color to the
        # string "transparent" (or to a non-None color) and must NOT
        # pass the literal ``None`` to ``button.configure``.
        assert 'fg_color="transparent"' in source, (
            "Regressed: un-select branch in _select_device no longer uses "
            '"transparent" — verify enhanced_device_selector.py:421 still '
            "uses an explicit color string and not None."
        )
        assert 'hover_color="transparent"' in source, (
            "Regressed: un-select branch in _select_device no longer uses "
            '"transparent" for hover_color.'
        )
        # The buggy line that shipped pre-fix was:
        #     button.configure(fg_color=None, hover_color=None)
        # Guard against it coming back.
        assert "fg_color=None, hover_color=None" not in source, (
            "Regressed: _select_device contains the original buggy line "
            '`fg_color=None, hover_color=None`. CustomTkinter raises '
            '`ValueError: color is None, for transparency set color=\'transparent\'`.'
        )

    @pytest.mark.unit
    def test_select_device_runs_without_value_error_on_second_selection(self, mock_tkinter_root):
        """Calling _select_device twice (selecting device B after A) must not raise ValueError.

        Constructs the minimum widget hierarchy needed by _select_device and
        exercises the un-select branch with mocks that record every
        ``configure()`` call. If any call receives ``fg_color=None`` or
        ``hover_color=None``, this test will catch the regression that
        bit us on 2026-06-05.
        """
        from customtkinter.windows.widgets.ctk_button import CTkButton

        with (
            patch("enhanced_device_selector.ctk.CTkFrame.__init__", return_value=None),
            patch.object(enhanced_device_selector.EnhancedDeviceSelector, "_create_widgets", return_value=None),
            patch("enhanced_device_selector.threading.Thread"),
        ):
            mock_parent = Mock()
            mock_parent._w = "mock_parent"

            selector = enhanced_device_selector.EnhancedDeviceSelector(mock_parent)

            # Build two fake device buttons and a parent frame.
            device_a = Mock()
            device_a.id = "vid:10d6:pid:af0c"
            device_b = Mock()
            device_b.id = "vid:10d6:pid:b00e"

            button_a = Mock(spec=CTkButton)
            button_a._device = device_a
            button_b = Mock(spec=CTkButton)
            button_b._device = device_b

            item_frame_a = Mock()
            item_frame_a._device_button = button_a
            item_frame_b = Mock()
            item_frame_b._device_button = button_b

            mock_list_frame = Mock()
            mock_list_frame.winfo_children.return_value = [item_frame_a, item_frame_b]
            selector.device_list_frame = mock_list_frame
            selector.status_label = Mock()

            # First selection — should select A, un-select nothing.
            selector._select_device(device_a)
            button_a.configure.assert_any_call(fg_color="green", hover_color="darkgreen")
            button_b.configure.assert_any_call(fg_color="transparent", hover_color="transparent")

            # Second selection — the critical regression point. Previously
            # raised ValueError. Now must complete cleanly.
            for call in button_a.configure.call_args_list:
                kwargs = call.kwargs
                assert kwargs.get("fg_color") is not None, (
                    "Regressed: button A's configure() received fg_color=None. "
                    "This is the bug that crashed the selector on 2026-06-05."
                )
                assert kwargs.get("hover_color") is not None, (
                    "Regressed: button A's configure() received hover_color=None."
                )
            for call in button_b.configure.call_args_list:
                kwargs = call.kwargs
                assert kwargs.get("fg_color") is not None
                assert kwargs.get("hover_color") is not None

            selector._select_device(device_b)  # Must not raise
```

- [ ] **Step 3: Verify the test file compiles**

```bash
"C:\Users\rcox\hidock-tools\hidock-next\apps\desktop\.venv.win\Scripts\python.exe" -m py_compile "C:\Users\rcox\hidock-tools\hidock-next\apps\desktop\tests\test_device_selector_comprehensive.py" && echo OK
```

Expected: `OK`

- [ ] **Step 4: Run the new tests**

From `apps/desktop/`:

```bash
cd "C:\Users\rcox\hidock-tools\hidock-next\apps\desktop" && "C:\Users\rcox\hidock-tools\hidock-next\apps\desktop\.venv.win\Scripts\python.exe" -m pytest tests/test_device_selector_comprehensive.py -v 2>&1 | tail -40
```

Expected: All existing tests + the two new tests pass. Total: 7 + 2 = 9 tests.

- [ ] **Step 5: Verify the test would catch a regression**

Temporarily revert the fix in `enhanced_device_selector.py:421` from `"transparent"` back to `None`, re-run the new test, confirm it FAILS, then restore the fix and confirm the test PASSES. This proves the test is a real regression guard, not a tautology.

```bash
# Backup
cp 'C:\Users\rcox\hidock-tools\hidock-next\apps\desktop\src\enhanced_device_selector.py' /tmp/eds.bak
# Edit line 421 back to None
```

Use `Edit` to revert just the one line:

```python
button.configure(fg_color=None, hover_color=None)
```

Run the test:

```bash
cd "C:\Users\rcox\hidock-tools\hidock-next\apps\desktop" && "C:\Users\rcox\hidock-tools\hidock-next\apps\desktop\.venv.win\Scripts\python.exe" -m pytest tests/test_device_selector_comprehensive.py::TestDeviceSelectorSelectionReset -v 2>&1 | tail -20
```

Expected: At least one test FAILS with a message referencing `fg_color=None`.

Restore the fix:

```bash
cp /tmp/eds.bak 'C:\Users\rcox\hidock-tools\hidock-next\apps\desktop\src\enhanced_device_selector.py'
```

Re-run the test to confirm it passes again.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/tests/test_device_selector_comprehensive.py
git commit -m "test(desktop): add regression test for device selector fg_color=None crash"
```

---

## Task 3: Update the design spec with post-implementation findings

**Files:**
- Modify: `docs/superpowers/specs/2026-06-05-hidock-p1-connect-fix-design.md` (add §12 documenting real-device findings)

The spec was written before real-device testing. Two findings emerged:

- **§A. Device selector crash at line 421** — `fg_color=None, hover_color=None` caused `ValueError` on second device selection. This was the proximate cause of the user's "No HiDock device found" error: the user couldn't select the P1 Mini in Settings → Connection because the selector crashed, so the GUI kept using the stale H1 config (`selected_vid: 4310, selected_pid: 44812` = `0x10D6:0xAF0C`).
- **§B. GUI design: explicit `device_id` bypasses the 24-pair scan** — `gui_actions_device.py:211` passes `device_id = f"{selected_vid:04x}:{selected_pid:04x}"` from config, and `desktop_device_adapter.connect()` only walks 24 pairs when `device_id is None`. The 24-pair fix is therefore only effective if the user picks a device in the selector first. Not a bug — the design is "user picks device, then connects" — but the user got stuck because §A prevented the pick.

These belong in the spec for the record, so future readers don't repeat the diagnosis.

- [ ] **Step 1: Append §12 to the spec**

Edit `docs/superpowers/specs/2026-06-05-hidock-p1-connect-fix-design.md`. Append at the end of the file:

```markdown

## 12. Post-implementation findings (real-device test, 2026-06-05)

Two issues surfaced when the user plugged in a P1 Mini (VID 0x10D6, PID 0xB00E per the web app's `requestDevice`) and clicked Connect in the desktop app. Both are documented here for the record; one is fixed in this branch, the other is a design observation, not a defect.

### 12.1 Device selector crash on second selection — FIXED

**Symptom:** Clicking a second device in `EnhancedDeviceSelector` raised `ValueError: color is None, for transparency set color='transparent'`. Captured in app log at 22:45:07:
```
File ".../enhanced_device_selector.py", line 421, in _select_device
    button.configure(fg_color=None, hover_color=None)
ValueError: color is None, for transparency set color='transparent'
```

**Root cause:** CustomTkinter requires explicit color values to reset to the theme default — `None` is not accepted. The un-select branch on the second click was passing `None`.

**Fix:** `enhanced_device_selector.py:421` — replaced `None` with the literal string `"transparent"` for both `fg_color` and `hover_color`. A regression test lives in `test_device_selector_comprehensive.py::TestDeviceSelectorSelectionReset` (added in this branch).

**Impact:** Without this fix, the device selector crashed the moment the user tried to select any device, leaving the GUI stuck on the stale `selected_vid`/`selected_pid` in the config (H1: `0x10D6:0xAF0C`). The "No HiDock device found" error in the desktop app was a downstream symptom of this crash, not the primary defect.

### 12.2 GUI design: explicit `device_id` bypasses the 24-pair scan — DESIGN OBSERVATION

**Symptom:** Even with the 24-pair scan in `desktop_device_adapter.connect()`, the desktop app reported "No HiDock device found" because `gui_actions_device.py:211` constructs a single-pair `device_id` from the GUI's `selected_vid_var`/`selected_pid_var` (which were stale at H1) and passes that to `connect()`. In `desktop_device_adapter.connect()`, when `device_id` is provided with a `:`, only that one pair is tried — the 24-pair fallback is bypassed entirely.

**Why this is not a bug:** The GUI is designed to use a device the user explicitly picked in the Settings → Connection tab. The 24-pair scan is the fallback for fresh installs where no device has been picked yet. The fix flow is: user opens Settings, picks the P1 Mini in the selector, clicks Connect. With the §12.1 crash fixed, this flow now works.

**Why this is worth noting:** A user with a brand-new P1 Mini who clicks Connect without first opening Settings will still see "No HiDock device found" — the GUI uses the default config (H1: `0x10D6:0xAF0C`) and won't fall through to the 24-pair scan. A future UX improvement would be to use `device_id=None` (auto-scan) when no device has been explicitly picked in the selector. Out of scope for this fix.
```

- [ ] **Step 2: Verify the spec still parses as valid Markdown**

The spec is rendered as Markdown in the documentation site. A simple sanity check: confirm the file has balanced backticks and no broken heading levels.

```bash
powershell -NoProfile -Command "Get-Content 'C:\Users\rcox\hidock-tools\hidock-next\docs\superpowers\specs\2026-06-05-hidock-p1-connect-fix-design.md' | Select-String '^##'" | Select-Object LineNumber, Line | Format-Table -AutoSize"
```

Expected: Section headers `## 1. Summary` through `## 12. Post-implementation findings (real-device test, 2026-06-05)`, all on `##` (no skipped levels).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-05-hidock-p1-connect-fix-design.md
git commit -m "docs: record post-implementation findings in P1 connect fix spec"
```

---

## Task 4: Final verification — full desktop test suite green

**Files:**
- No file changes. Pure verification.

Before declaring this plan done, run the full desktop test suite (unit marker only, no GUI/integration) to confirm no regressions and that the new conftest fix didn't break anything.

- [ ] **Step 1: Run the unit subset of the desktop test suite**

From `apps/desktop/`:

```bash
cd "C:\Users\rcox\hidock-tools\hidock-next\apps\desktop" && "C:\Users\rcox\hidock-tools\hidock-next\apps\desktop\.venv.win\Scripts\python.exe" -m pytest tests/ -m unit -q 2>&1 | tail -50
```

Expected: A pass/fail summary like `=== XXX passed, YYY failed in ZZs ===` with **0 failures**. The exact pass count depends on how many tests existed before, but `test_desktop_device_adapter.py` (6 tests) and `test_device_selector_comprehensive.py` (now 9 tests) should be in the list and passing.

- [ ] **Step 2: Run the full desktop test suite (no marker filter) to confirm no slow/integration tests regressed**

From `apps/desktop/`:

```bash
cd "C:\Users\rcox\hidock-tools\hidock-next\apps\desktop" && "C:\Users\rcox\hidock-tools\hidock-next\apps\desktop\.venv.win\Scripts\python.exe" -m pytest tests/ -q 2>&1 | tail -20
```

Expected: 0 failures. (Slow/integration tests are skipped by default per `pytest.ini`; this confirms the conftest change doesn't break the GUI-marker tests either.)

- [ ] **Step 3: Final review of the working tree**

```bash
git status
git log --oneline -5
```

Expected: A clean working tree, with the last 4-5 commits including:
- `fix(usb): ...` or similar (the 8-fix implementation pass — may not exist yet, see Task 5)
- `test(desktop): add src/ to sys.path so test collection works`
- `test(desktop): add regression test for device selector fg_color=None crash`
- `docs: record post-implementation findings in P1 connect fix spec`

---

## Task 5: Commit the originally-shipped code (if not already committed)

**Files:** All the working-tree changes from the 8-fix implementation pass.

This task is contingent on whether the original implementation pass was committed. The user's spec said "No commit yet" — the diff was staged for review. If the user has since committed those changes, this task is a no-op. If not, this is the final commit.

- [ ] **Step 1: Check what's still unstaged**

```bash
git status
```

Expected output scenarios:
- **Scenario A:** Working tree clean except for the three new commits from Tasks 1-3. Done — skip to Task 6.
- **Scenario B:** Working tree shows a long list of modified files matching the 8-fix implementation pass (`desktop_device_adapter.py`, `enhanced_device_selector.py`, `config_and_logger.py`, `gui_main_window.py`, `settings_window.py`, the web app files, `hidock_config.json.example`, etc.). Continue with Steps 2-4.

- [ ] **Step 2: Stage and commit the implementation pass (Scenario B only)**

```bash
git add apps/desktop/src/desktop_device_adapter.py \
        apps/desktop/src/enhanced_device_selector.py \
        apps/desktop/src/config_and_logger.py \
        apps/desktop/src/gui_main_window.py \
        apps/desktop/src/settings_window.py \
        apps/desktop/config/hidock_config.json.example \
        apps/desktop/tests/test_desktop_device_adapter.py \
        apps/desktop/tests/test_desktop_device_selector.py \
        apps/desktop/tests/test_config_and_logger.py \
        apps/desktop/tests/test_settings_persistence.py \
        apps/desktop/tests/test_settings_persistence_root_cause.py \
        apps/desktop/tests/test_utils.py \
        apps/web/src/adapters/webDeviceAdapter.ts \
        apps/web/src/services/deviceService.ts \
        apps/web/src/test/deviceService.test.ts
```

(The exact file list will vary if the user has committed some of these already. Adjust as needed; the goal is to get the working tree clean.)

Commit with a comprehensive message:

```bash
git commit -m "$(cat <<'EOF'
fix(usb): support 0x3887 P1 Mini + remove dead target_interface setting

Desktop:
- desktop_device_adapter: walk ALL_VENDOR_IDS × HIDOCK_PRODUCT_IDS when no
  explicit device_id is provided; preserve single-pair behavior when the
  caller pins a specific device.
- enhanced_device_selector: accept every HiDock VID/PID combination
  (was hardcoded H1-only list).
- Remove dead `target_interface` setting from config schema, settings UI,
  GUI, example config, and 6 test/conftest files. Stale values in existing
  configs are silently dropped on next save.

Web:
- webDeviceAdapter.discoverDevices uses HIDOCK_VENDOR_IDS.includes(...)
  (was strict equality to single VENDOR_ID).
- deviceService.isHiDockDevice uses HIDOCK_VENDOR_IDS.includes(...)
  (was 0x10D6 || 0x1a86 — accepted CH340, rejected 0x3887).
- Note: 0x1a86 in the requestDevice filter is intentional (CH340 cable
  compat) and is NOT a defect. Comment added at L1918 to lock in the
  distinction.

Safety:
- All USB changes use mock-only unit tests per CLAUDE.md. New tests in
  test_desktop_device_adapter.py (6), test_device_selector_comprehensive
  .py (7), and deviceService.test.ts (6). No real-device verification
  performed in this commit.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Verify clean working tree**

```bash
git status
```

Expected: `nothing to commit, working tree clean`.

- [ ] **Step 4: Verify commit history looks right**

```bash
git log --oneline -10
```

Expected: The full sequence visible — original 8-fix commit (if not already present), then the 3 new commits from Tasks 1-3.

---

## Task 6: Update the spec index and close out

**Files:**
- Modify: `docs/superpowers/specs/` (no file changes — this task is a final report-back to the user)

The spec index file (if one exists) should be updated to reflect that the plan was completed. But there's no separate index — `docs/superpowers/plans/` and `docs/superpowers/specs/` are referenced by the superpowers tooling, not by a hand-maintained index. The plan file itself, once committed, is the deliverable.

- [ ] **Step 1: Final summary back to the user**

Report:
- The 3 tasks completed (test-path fix, selector crash regression test, spec update)
- The 1 contingent task (Task 5) — committed the original 8-fix pass if it was uncommitted
- Total commits added by this plan: 3 (or 4 if Task 5 fired)
- Verification result from Task 4 (full desktop test suite green)
- No real-device verification (per CLAUDE.md); the user must re-verify on hardware

Do **not** run any USB code. Do **not** suggest "let's plug the P1 in to verify" — that's the user's call, and they have the new selector test to give them confidence the crash is fixed.

---

## Self-Review

**1. Spec coverage:**
- §1-§7 (the 8 fixes) — implemented and shipped; the plan does not re-implement them, it locks them in with tests.
- §10 follow-up #1 (test-path setup) — Task 1 covers this.
- §10 follow-up #2 (electron app) — explicitly out of scope per spec §8.
- §10 follow-up #3 (commit the changes) — Task 5 covers this.
- §10 follow-up #4 (0x1a86 in web filter) — explicitly not a defect per spec §5.2 / §6; no action.
- New findings from real-device testing (§12.1, §12.2 in updated spec) — Task 2 covers §12.1; §12.2 is a documentation-only observation, captured in Task 3.

**2. Placeholder scan:**
- No "TBD", "TODO", "implement later" anywhere.
- All test code is complete (no "similar to Task N" references).
- All file paths are exact.
- All commands include expected output.
- Mock patterns match the existing `test_device_selector_comprehensive.py` style.

**3. Type consistency:**
- `enhanced_device_selector.EnhancedDeviceSelector._select_device` — referenced in Task 2 Step 2 (twice) and Task 1 (conftest fix doesn't touch this). Consistent.
- `device_info.vendor_id` / `device_info.product_id` — not referenced in this plan; the spec mentions them in §4.1 only. No conflict.
- `select_device` (the GUI's settings_window method) — not used in the plan. The plan targets `_select_device` (the selector's internal method) only. No conflict.
- `fg_color="transparent"` — used in Task 2's test (Step 2 line `assert 'fg_color="transparent"' in source`) and in the test's mock-call assertion. Matches the fix.
- `mock_tkinter_root` fixture — defined in `conftest.py` line 305+. Used in Task 2 Step 2. The conftest change in Task 1 doesn't touch this fixture, so it's safe.
- `pytest.mark.unit` — used consistently across both new test classes.

No issues found.
