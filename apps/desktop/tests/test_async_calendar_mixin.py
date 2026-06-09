#!/usr/bin/env python3
"""
Tests for async_calendar_mixin.py
Covers async calendar initialization, status reporting, and method compatibility.

Gate 4 Task 2 — fixes applied:
  - mock_gui closure bug: every nested TestMixin now uses Mock() directly instead
    of self.mock_gui (which is a TestCase attribute invisible inside the nested
    class __init__).
  - Deleted-API realignments: tests that called _initialize_async_calendar /
    _schedule_async_init / _calendar_status / _calendar_available /
    CALENDAR_AVAILABLE (all removed from the live mixin) are either realigned
    to the live API (_ensure_async_calendar_initialized,
    _initialize_async_calendar_components, SIMPLE_CALENDAR_AVAILABLE) or
    deleted when no live equivalent exists.
  - test_schedule_async_init_method: DELETED — _schedule_async_init no longer
    exists and there is no live equivalent.
  - TestAsyncCalendarMixinIntegration.test_full_integration_flow: DELETED —
    patches CALENDAR_AVAILABLE (removed) and calls _initialize_async_calendar
    (removed async method); the integration scenario is covered by
    test_initialize_components_success + test_enhance_files_with_meeting_data_no_calendar.
"""

import sys
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, patch

# Add the parent directory to sys.path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))


class TestAsyncCalendarMixin(unittest.TestCase):
    """Test the AsyncCalendarMixin functionality."""

    def setUp(self):
        """Set up test fixtures."""
        # mock_gui is kept on the TestCase for reference, but individual tests
        # that define nested TestMixin classes must NOT reference self.mock_gui
        # inside the nested __init__ — the attribute lives on the TestCase, not
        # the nested class.  Each nested TestMixin uses Mock() directly instead.
        self.mock_gui = Mock()
        self.mock_gui.after = Mock()
        self.mock_gui.update_calendar_status = Mock()

    def test_import_async_calendar_mixin(self):
        """Test that async_calendar_mixin can be imported."""
        try:
            import async_calendar_mixin

            self.assertTrue(hasattr(async_calendar_mixin, "AsyncCalendarMixin"))
        except ImportError as e:
            self.fail(f"Failed to import async_calendar_mixin: {e}")

    @patch("async_calendar_mixin.SIMPLE_CALENDAR_AVAILABLE", False)
    def test_async_calendar_mixin_initialization(self):
        """Test AsyncCalendarMixin initialization.

        Realigned (Gate 4 Task 2): the live mixin has no _calendar_status,
        _calendar_available, or _initialization_complete attrs.  Instead it sets
        up its state lazily via _ensure_async_calendar_initialized, which sets
        _async_calendar_initialized.  With SIMPLE_CALENDAR_AVAILABLE=False the
        init completes without starting a worker thread.
        """
        from async_calendar_mixin import AsyncCalendarMixin

        class TestMixin(AsyncCalendarMixin):
            def __init__(self):
                # Use Mock() directly — self.mock_gui is a TestCase attr, not
                # visible inside nested __init__.
                self.gui = Mock()

        mixin = TestMixin()

        # State does NOT exist before _ensure_async_calendar_initialized is called.
        self.assertFalse(hasattr(mixin, "_async_calendar_initialized"))

        # After calling it the mixin marks itself as initialised.
        mixin._ensure_async_calendar_initialized()
        self.assertTrue(mixin._async_calendar_initialized)
        self.assertIsNone(mixin._calendar_integration)

    @patch("async_calendar_mixin.SIMPLE_CALENDAR_AVAILABLE", False)
    def test_ensure_async_calendar_initialized(self):
        """Test the _ensure_async_calendar_initialized method.

        Realigned (Gate 4 Task 2): the live implementation does NOT call
        self.gui.after.  It initialises internal state synchronously.
        With SIMPLE_CALENDAR_AVAILABLE=False, _initialize_async_calendar_components
        returns early, so no CalendarCacheManager or integration is created.
        """
        from async_calendar_mixin import AsyncCalendarMixin

        class TestMixin(AsyncCalendarMixin):
            def __init__(self):
                self.gui = Mock()

        mixin = TestMixin()
        mixin._ensure_async_calendar_initialized()

        # The flag must be set after initialization.
        self.assertTrue(mixin._async_calendar_initialized)
        # With no calendar available the integration stays None.
        self.assertIsNone(mixin._calendar_integration)

    @patch("async_calendar_mixin.SIMPLE_CALENDAR_AVAILABLE", False)
    def test_calendar_status_text_for_gui(self):
        """Test get_calendar_status_text_for_gui method.

        Realigned (Gate 4 Task 2): the live method delegates to
        get_calendar_status_text_for_gui_async which reads SIMPLE_CALENDAR_AVAILABLE
        and _calendar_integration.  With SIMPLE_CALENDAR_AVAILABLE=False it
        returns "Calendar: Not Available".
        """
        from async_calendar_mixin import AsyncCalendarMixin

        class TestMixin(AsyncCalendarMixin):
            def __init__(self):
                self.gui = Mock()

        mixin = TestMixin()
        status = mixin.get_calendar_status_text_for_gui()
        self.assertEqual(status, "Calendar: Not Available")

    @patch("async_calendar_mixin.SIMPLE_CALENDAR_AVAILABLE", False)
    def test_compatibility_wrapper_methods(self):
        """Test that compatibility wrapper methods exist."""
        from async_calendar_mixin import AsyncCalendarMixin

        class TestMixin(AsyncCalendarMixin):
            def __init__(self):
                self.gui = Mock()

        mixin = TestMixin()

        # Compatibility wrappers required by the GUI layer.
        self.assertTrue(hasattr(mixin, "get_calendar_status_text_for_gui"))
        self.assertTrue(hasattr(mixin, "enhance_files_with_meeting_data"))

    @patch("async_calendar_mixin.SIMPLE_CALENDAR_AVAILABLE", False)
    def test_enhance_files_with_meeting_data_empty(self):
        """Test enhance_files_with_meeting_data with empty file list."""
        from async_calendar_mixin import AsyncCalendarMixin

        class TestMixin(AsyncCalendarMixin):
            def __init__(self):
                self.gui = Mock()

        mixin = TestMixin()

        result = mixin.enhance_files_with_meeting_data([])
        self.assertEqual(result, [])

    @patch("async_calendar_mixin.SIMPLE_CALENDAR_AVAILABLE", False)
    def test_enhance_files_with_meeting_data_no_calendar(self):
        """Test enhance_files_with_meeting_data when calendar not available."""
        from async_calendar_mixin import AsyncCalendarMixin

        class TestMixin(AsyncCalendarMixin):
            def __init__(self):
                self.gui = Mock()

        mixin = TestMixin()

        files_dict = [
            {"name": "test.wav", "time": datetime.now(), "createDate": "2023-01-01", "createTime": "10:00:00"}
        ]

        result = mixin.enhance_files_with_meeting_data(files_dict)

        # Should return files immediately with empty meeting fields.
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["name"], "test.wav")
        self.assertIn("has_meeting", result[0])
        self.assertFalse(result[0]["has_meeting"])

    @patch("async_calendar_mixin.SIMPLE_CALENDAR_AVAILABLE", True)
    @patch("async_calendar_mixin.create_simple_outlook_integration")
    @patch("async_calendar_mixin.CalendarCacheManager")
    def test_initialize_components_success(self, mock_cache_cls, mock_create_integration):
        """Realigned (Gate 4 Task 2): the live API is _initialize_async_calendar_components
        gated on SIMPLE_CALENDAR_AVAILABLE, not the removed async _initialize_async_calendar.
        With a successful integration (is_available=True) the mixin stores the
        integration object and starts a worker thread.
        """
        from async_calendar_mixin import AsyncCalendarMixin

        mock_integration = Mock()
        mock_integration.is_available.return_value = True
        mock_create_integration.return_value = mock_integration

        mock_cache = Mock()
        mock_cache_cls.return_value = mock_cache

        class TestMixin(AsyncCalendarMixin):
            def __init__(self):
                self.gui = Mock()
                # Pre-initialise the attrs _initialize_async_calendar_components writes to
                # so they exist when the method checks them.
                self._calendar_integration = None
                self._calendar_cache_manager = None
                self._calendar_work_queue = __import__("queue").Queue()

        mixin = TestMixin()

        # Patch _calendar_worker_loop to avoid a real background thread.
        with patch.object(mixin, "_calendar_worker_loop"):
            mixin._initialize_async_calendar_components()

        self.assertIsNotNone(mixin._calendar_integration)
        mock_create_integration.assert_called_once()

    @patch("async_calendar_mixin.SIMPLE_CALENDAR_AVAILABLE", True)
    @patch("async_calendar_mixin.create_simple_outlook_integration")
    @patch("async_calendar_mixin.CalendarCacheManager")
    def test_initialize_components_handles_integration_exception(self, mock_cache_cls, mock_create_integration):
        """Realigned (Gate 4 Task 2): _initialize_async_calendar_components must
        swallow an exception raised by create_simple_outlook_integration (the
        src except branch at async_calendar_mixin.py:74-75) rather than propagate.
        After the swallowed exception _calendar_integration stays None.

        create_simple_outlook_integration is called *inside* the try, after the
        CalendarCacheManager is constructed, so making it raise drives execution
        straight into the except block.  No test previously covered this branch.
        """
        from async_calendar_mixin import AsyncCalendarMixin

        mock_cache_cls.return_value = Mock()
        mock_create_integration.side_effect = Exception("boom")

        class TestMixin(AsyncCalendarMixin):
            def __init__(self):
                self.gui = Mock()
                self._calendar_integration = None
                self._calendar_cache_manager = None
                self._calendar_work_queue = __import__("queue").Queue()

        mixin = TestMixin()

        with patch.object(mixin, "_calendar_worker_loop"):
            # Must NOT raise — the except branch swallows the exception.
            mixin._initialize_async_calendar_components()

        # The integration assignment (line 64) raised, so it stays None.
        self.assertIsNone(mixin._calendar_integration)
        mock_create_integration.assert_called_once()

    @patch("async_calendar_mixin.SIMPLE_CALENDAR_AVAILABLE", True)
    def test_status_text_reports_integration_unavailable(self):
        """Realigned (Gate 4 Task 2): exercises the availability branch that the
        old (misnamed, near-duplicate) test failed to reach.

        _initialize_async_calendar_components never calls is_available(), so the
        availability branch lives in get_calendar_status_text_for_gui_async
        (async_calendar_mixin.py:887-888): when the integration exists but
        is_available() is False, the live code returns the integration's own
        get_calendar_status_text() output.  This asserts that real "unavailable"
        output is surfaced verbatim.
        """
        from async_calendar_mixin import AsyncCalendarMixin

        mock_integration = Mock()
        mock_integration.is_available.return_value = False
        mock_integration.get_calendar_status_text.return_value = "Calendar: Outlook Not Connected"

        class TestMixin(AsyncCalendarMixin):
            def __init__(self):
                self.gui = Mock()

        mixin = TestMixin()
        # Mark init done and inject an unavailable integration so the status
        # method reaches the is_available()==False branch.
        mixin._async_calendar_initialized = True
        mixin._calendar_integration = mock_integration
        mixin._calendar_cache_manager = Mock()
        mixin._calendar_sync_status = "idle"

        status = mixin.get_calendar_status_text_for_gui()

        # The unavailable branch surfaces the integration's own status text verbatim.
        self.assertEqual(status, "Calendar: Outlook Not Connected")
        mock_integration.is_available.assert_called()
        mock_integration.get_calendar_status_text.assert_called_once()

    @patch("async_calendar_mixin.SIMPLE_CALENDAR_AVAILABLE", False)
    def test_calendar_status_before_initialization(self):
        """Test calendar status before async initialization.

        Realigned (Gate 4 Task 2): with SIMPLE_CALENDAR_AVAILABLE=False the live
        get_calendar_status_text_for_gui_async immediately returns
        "Calendar: Not Available" without requiring prior init.
        """
        from async_calendar_mixin import AsyncCalendarMixin

        class TestMixin(AsyncCalendarMixin):
            def __init__(self):
                self.gui = Mock()

        mixin = TestMixin()

        status = mixin.get_calendar_status_text_for_gui()
        self.assertEqual(status, "Calendar: Not Available")

    # test_schedule_async_init_method — DELETED (Gate 4 Task 2).
    # _schedule_async_init no longer exists in the live mixin and there is no
    # live equivalent; the init is now lazy via _ensure_async_calendar_initialized.

    @patch("async_calendar_mixin.SIMPLE_CALENDAR_AVAILABLE", False)
    def test_concurrent_initialization_protection(self):
        """Test that concurrent / repeated initializations are idempotent.

        Realigned (Gate 4 Task 2): the live _ensure_async_calendar_initialized
        checks hasattr(self, '_async_calendar_initialized') so calling it
        multiple times is safe and does NOT call self.gui.after.
        """
        from async_calendar_mixin import AsyncCalendarMixin

        class TestMixin(AsyncCalendarMixin):
            def __init__(self):
                self.gui = Mock()

        mixin = TestMixin()

        # Call multiple times — should be idempotent.
        mixin._ensure_async_calendar_initialized()
        mixin._ensure_async_calendar_initialized()
        mixin._ensure_async_calendar_initialized()

        # The flag is set exactly once and stays True.
        self.assertTrue(mixin._async_calendar_initialized)

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
                # Mirror the established TestMixin attribute set used elsewhere in
                # this file so the test stays robust if _parse_file_datetime later
                # reads a self-attribute. (A real Mock GUI is used here rather than
                # self.mock_gui, which is a TestCase attribute not visible inside
                # this inner mixin __init__.)
                self.gui = Mock()
                self._calendar_integration = None

        mixin = TestMixin()

        # 1. datetime 'time' field returned unchanged
        ts = datetime(2023, 1, 15, 10, 30, 0)
        self.assertEqual(mixin._parse_file_datetime({"time": ts}), ts)

        # 2. device createDate/createTime strings parse. NOTE: the device uses the
        # slash format "%Y/%m/%d %H:%M:%S" (per CLAUDE.md Jensen protocol), NOT the
        # hyphen format the old deleted simple_calendar test asserted.
        parsed = mixin._parse_file_datetime({"createDate": "2023/01/15", "createTime": "10:30:00"})
        self.assertEqual(parsed, datetime(2023, 1, 15, 10, 30, 0))

        # 3. missing datetime data -> None
        self.assertIsNone(mixin._parse_file_datetime({"name": "test.wav"}))

        # 4. malformed date string -> None
        self.assertIsNone(mixin._parse_file_datetime({"createDate": "invalid-date", "createTime": "10:30:00"}))


# TestAsyncCalendarMixinIntegration.test_full_integration_flow — DELETED
# (Gate 4 Task 2).  The test patched CALENDAR_AVAILABLE (removed module attr)
# and called _initialize_async_calendar (removed async method).  The
# integration scenario is covered by test_initialize_components_success and
# test_enhance_files_with_meeting_data_no_calendar above.


if __name__ == "__main__":
    unittest.main()
