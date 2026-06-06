"""
Comprehensive test for device selector functionality.

This consolidates device selector tests to avoid race conditions
that can occur when running multiple separate test files.
"""

import inspect
import sys
from unittest.mock import Mock, patch

import pytest

# Mock GUI modules to prevent tkinter initialization issues
sys.modules["tkinter.messagebox"] = Mock()
sys.modules["tkinter.filedialog"] = Mock()
sys.modules["tkinter.ttk"] = Mock()
sys.modules["tkinter.simpledialog"] = Mock()

# Import at module level to avoid race conditions
import enhanced_device_selector
import settings_window


class TestDeviceSelectorComprehensive:
    """Comprehensive test for device selector functionality."""

    def setup_method(self):
        """Set up each test method with clean state."""
        # Clear any existing patches or state
        pass

    def teardown_method(self):
        """Clean up after each test method."""
        # Ensure no lingering threads or state
        pass

    # Interface Contract Tests
    @pytest.mark.unit
    def test_enhanced_device_selector_class_has_set_enabled_method(self):
        """EnhancedDeviceSelector class should have set_enabled method."""
        # Check that the class has the method
        assert hasattr(enhanced_device_selector.EnhancedDeviceSelector, "set_enabled")

        # Check that it's callable
        method = getattr(enhanced_device_selector.EnhancedDeviceSelector, "set_enabled")
        assert callable(method)

    @pytest.mark.unit
    def test_device_selector_method_signature(self):
        """set_enabled method should have correct signature."""
        method = enhanced_device_selector.EnhancedDeviceSelector.set_enabled
        sig = inspect.signature(method)

        # Should have self and enabled parameters
        params = list(sig.parameters.keys())
        assert "self" in params
        assert "enabled" in params

        # enabled parameter should have bool type hint
        enabled_param = sig.parameters["enabled"]
        assert enabled_param.annotation == bool

    # Implementation Behavior Tests
    @pytest.mark.unit
    def test_enhanced_device_selector_has_set_enabled_method(self):
        """EnhancedDeviceSelector should have set_enabled method."""
        # Mock the entire widget creation process and threading
        with (
            patch("enhanced_device_selector.ctk.CTkFrame.__init__", return_value=None),
            patch.object(enhanced_device_selector.EnhancedDeviceSelector, "_create_widgets", return_value=None),
            patch("enhanced_device_selector.threading.Thread"),
        ):
            mock_parent = Mock()
            mock_parent._w = "mock_parent"

            # Create the device selector
            selector = enhanced_device_selector.EnhancedDeviceSelector(mock_parent)

            # Should have set_enabled method
            assert hasattr(selector, "set_enabled")
            assert callable(selector.set_enabled)

    @pytest.mark.unit
    def test_set_enabled_method_works(self):
        """set_enabled method should work without errors."""
        # Mock the entire widget creation process and threading
        with (
            patch("enhanced_device_selector.ctk.CTkFrame.__init__", return_value=None),
            patch.object(enhanced_device_selector.EnhancedDeviceSelector, "_create_widgets", return_value=None),
            patch("enhanced_device_selector.threading.Thread"),
        ):
            mock_parent = Mock()
            mock_parent._w = "mock_parent"

            # Create the device selector
            selector = enhanced_device_selector.EnhancedDeviceSelector(mock_parent)

            # Mock the required attributes
            selector.scan_button = Mock()
            selector.device_list_frame = Mock()
            selector.device_list_frame.winfo_children.return_value = []
            selector.status_label = Mock()

            # Should not raise an error
            selector.set_enabled(False)
            selector.set_enabled(True)

            # Verify scan button was configured
            assert selector.scan_button.configure.call_count >= 2

    @pytest.mark.unit
    def test_set_enabled_false_disables_components(self):
        """set_enabled(False) should disable scan button and show warning."""
        # Mock the entire widget creation process and threading
        with (
            patch("enhanced_device_selector.ctk.CTkFrame.__init__", return_value=None),
            patch.object(enhanced_device_selector.EnhancedDeviceSelector, "_create_widgets", return_value=None),
            patch("enhanced_device_selector.threading.Thread"),
        ):
            mock_parent = Mock()
            mock_parent._w = "mock_parent"

            # Create the device selector
            selector = enhanced_device_selector.EnhancedDeviceSelector(mock_parent)

            # Mock the required attributes
            selector.scan_button = Mock()
            selector.device_list_frame = Mock()
            selector.device_list_frame.winfo_children.return_value = []
            selector.status_label = Mock()

            # Disable the selector
            selector.set_enabled(False)

            # Verify scan button was disabled
            selector.scan_button.configure.assert_called_with(state="disabled")

            # Verify status message was updated
            expected_text = "⚠️ Device selection disabled while connected"
            selector.status_label.configure.assert_called_with(text=expected_text)

    @pytest.mark.unit
    def test_set_enabled_true_enables_components(self):
        """set_enabled(True) should enable scan button."""
        # Mock the entire widget creation process and threading
        with (
            patch("enhanced_device_selector.ctk.CTkFrame.__init__", return_value=None),
            patch.object(enhanced_device_selector.EnhancedDeviceSelector, "_create_widgets", return_value=None),
            patch("enhanced_device_selector.threading.Thread"),
        ):
            mock_parent = Mock()
            mock_parent._w = "mock_parent"

            # Create the device selector
            selector = enhanced_device_selector.EnhancedDeviceSelector(mock_parent)

            # Mock the required attributes
            selector.scan_button = Mock()
            selector.device_list_frame = Mock()
            selector.device_list_frame.winfo_children.return_value = []
            selector.status_label = Mock()

            # Enable the selector
            selector.set_enabled(True)

            # Verify scan button was enabled
            selector.scan_button.configure.assert_called_with(state="normal")

    # Integration Tests
    @pytest.mark.unit
    def test_settings_window_uses_set_enabled_not_configure(self):
        """Settings window should use set_enabled method, not configure."""
        # Read the source code to verify the fix
        source = inspect.getsource(settings_window.SettingsDialog._populate_connection_tab)

        # Should contain set_enabled call
        assert "set_enabled(False)" in source

        # Should NOT contain the old configure call
        assert 'configure(state="disabled")' not in source

    @pytest.mark.unit
    def test_device_selector_integration_with_settings(self):
        """Device selector should integrate properly with settings dialog."""
        # Mock the EnhancedDeviceSelector to avoid GUI initialization
        mock_device_selector = Mock()
        mock_device_selector.set_enabled = Mock()

        # Mock all GUI components to avoid tkinter initialization
        with (
            patch("enhanced_device_selector.EnhancedDeviceSelector", return_value=mock_device_selector),
            patch("settings_window.ctk.CTkScrollableFrame") as mock_scrollable_frame,
            patch("settings_window.ctk.CTkLabel"),
            patch("settings_window.ctk.CTkFrame"),
            patch("settings_window.ctk.CTkFont") as mock_font,
            patch("settings_window.ctk.CTkCheckBox"),
            patch("settings_window.ctk.CTkEntry"),
            patch("threading.Thread"),
        ):
            # Mock font creation
            mock_font.return_value = Mock()

            # Create properly mocked tab with tkinter attributes
            mock_tab = Mock()
            mock_tab._w = "mock_tab_widget"
            mock_tab.tk = Mock()

            # Mock the scrollable frame with proper tkinter attributes
            mock_scroll_frame_instance = Mock()
            mock_scroll_frame_instance._w = "mock_scroll_frame"
            mock_scroll_frame_instance.tk = Mock()
            mock_scrollable_frame.return_value = mock_scroll_frame_instance

            # Create dialog instance without initialization
            dialog = settings_window.SettingsDialog.__new__(settings_window.SettingsDialog)
            dialog.dock = Mock()
            dialog.dock.is_connected.return_value = True
            dialog.local_vars = {"autoconnect_var": Mock()}

            # This should not raise an error
            dialog._populate_connection_tab(mock_tab)

            # The device selector should be created and disabled
            mock_device_selector.set_enabled.assert_called_with(False)


# ----------------------------------------------------------------------
# Regression tests for the P1 / 0x3887 connect fix
# ----------------------------------------------------------------------
#
# enhanced_device_selector previously hard-coded a list of [VID, PID]
# pairs. That list omitted 0x3887 (the newer P1 Mini vendor), so the
# selector reported "no devices" even when a P1 Mini was plugged in.
# The fixed code routes the membership check through
# ``ALL_VENDOR_IDS`` and ``HIDOCK_PRODUCT_IDS`` from constants.py so
# every supported VID/PID is discoverable.


class TestEnhancedDeviceSelectorHidockMembership:
    """Verify the device selector accepts every HiDock VID/PID pair."""

    @pytest.fixture
    def selector(self):
        """Build an EnhancedDeviceSelector with all GUI side effects mocked."""
        with (
            patch("enhanced_device_selector.ctk.CTkFrame.__init__", return_value=None),
            patch.object(enhanced_device_selector.EnhancedDeviceSelector, "_create_widgets", return_value=None),
            patch("enhanced_device_selector.threading.Thread"),
        ):
            mock_parent = Mock()
            mock_parent._w = "mock_parent"
            yield enhanced_device_selector.EnhancedDeviceSelector(mock_parent)

    @pytest.mark.unit
    def test_accepts_every_hidock_vendor(self, selector):
        """Every VID in ALL_VENDOR_IDS must be accepted."""
        from constants import ALL_VENDOR_IDS, HIDOCK_PRODUCT_IDS

        any_pid = HIDOCK_PRODUCT_IDS[0]
        for vid in ALL_VENDOR_IDS:
            assert selector._is_hidock_device(vid, any_pid) is True, (
                f"VID {hex(vid)} should be recognised as HiDock"
            )

    @pytest.mark.unit
    def test_accepts_every_hidock_product(self, selector):
        """Every PID in HIDOCK_PRODUCT_IDS must be accepted for a HiDock VID."""
        from constants import ALL_VENDOR_IDS, HIDOCK_PRODUCT_IDS

        any_vid = ALL_VENDOR_IDS[0]
        for pid in HIDOCK_PRODUCT_IDS:
            assert selector._is_hidock_device(any_vid, pid) is True, (
                f"PID {hex(pid)} should be recognised as HiDock"
            )

    @pytest.mark.unit
    def test_accepts_0x3887_p1_mini(self, selector):
        """0x3887 is the new P1 Mini vendor; it must NOT be filtered out."""
        from constants import HIDOCK_PRODUCT_IDS

        any_pid = HIDOCK_PRODUCT_IDS[0]
        # This is the exact regression that started this fix.
        assert selector._is_hidock_device(0x3887, any_pid) is True

    @pytest.mark.unit
    def test_rejects_unknown_vendor(self, selector):
        """VIDs outside ALL_VENDOR_IDS are not HiDock."""
        from constants import HIDOCK_PRODUCT_IDS

        any_pid = HIDOCK_PRODUCT_IDS[0]
        # 0x1234 is a placeholder non-HiDock vendor.
        assert selector._is_hidock_device(0x1234, any_pid) is False

    @pytest.mark.unit
    def test_rejects_unknown_product(self, selector):
        """PIDs outside HIDOCK_PRODUCT_IDS are not HiDock."""
        from constants import ALL_VENDOR_IDS

        any_vid = ALL_VENDOR_IDS[0]
        # 0xDEAD is a placeholder non-HiDock product.
        assert selector._is_hidock_device(any_vid, 0xDEAD) is False

    @pytest.mark.unit
    def test_model_name_for_known_pid(self, selector):
        """_get_hidock_model_name returns a short label for known PIDs."""
        from constants import HIDOCK_PRODUCT_IDS

        for pid in HIDOCK_PRODUCT_IDS:
            name = selector._get_hidock_model_name(pid)
            assert name and "Unknown" not in name, (
                f"PID {hex(pid)} should map to a known model name, got '{name}'"
            )

    @pytest.mark.unit
    def test_model_name_for_unknown_pid(self, selector):
        """_get_hidock_model_name returns 'Unknown (0xPID)' for unrecognised PIDs."""
        name = selector._get_hidock_model_name(0xDEAD)
        assert "Unknown" in name
        assert "dead" in name.lower()


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


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
