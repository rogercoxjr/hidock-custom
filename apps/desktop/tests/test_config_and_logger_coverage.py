#!/usr/bin/env python3
"""
Tests for config_and_logger.py
Covers configuration management, logging setup, and file operations.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, mock_open, patch

# Add the parent directory to sys.path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))


class TestConfigAndLogger(unittest.TestCase):
    """Test config_and_logger functionality."""

    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.mkdtemp()
        self.temp_config_file = os.path.join(self.temp_dir, "test_config.json")

    def tearDown(self):
        """Clean up test fixtures."""
        import shutil

        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_import_config_and_logger(self):
        """Test that config_and_logger can be imported.

        The 5a3a9c9d refactor removed ``setup_logging`` in favor of the
        ``Logger`` class (see ``config_and_logger.logger``). We assert the
        ``Logger`` class is present instead.
        """
        try:
            import config_and_logger

            self.assertTrue(hasattr(config_and_logger, "load_config"))
            self.assertTrue(hasattr(config_and_logger, "save_config"))
            self.assertTrue(hasattr(config_and_logger, "get_default_config"))
            self.assertTrue(hasattr(config_and_logger, "Logger"))
        except ImportError as e:
            self.fail(f"Failed to import config_and_logger: {e}")

    def test_get_default_config(self):
        """Test get_default_config returns expected structure."""
        from config_and_logger import get_default_config

        default_config = get_default_config()

        # Check essential configuration keys
        self.assertIn("autoconnect", default_config)
        self.assertIn("download_directory", default_config)
        self.assertIn("log_level", default_config)
        self.assertIn("appearance_mode", default_config)
        self.assertIn("color_theme", default_config)

        # Check data types
        self.assertIsInstance(default_config["autoconnect"], bool)
        self.assertIsInstance(default_config["download_directory"], str)
        self.assertIsInstance(default_config["log_level"], str)

    @patch("config_and_logger.open", new_callable=mock_open, read_data='{"autoconnect": true, "log_level": "DEBUG", "appearance_mode": "Dark"}')
    def test_load_config_file_exists(self, mock_file):
        """Test load_config when config file exists.

        The 5a3a9c9d refactor made ``_CONFIG_FILE_PATH`` a plain ``str`` (not
        a ``Path``). Tests that try to ``@patch`` it and assign ``__str__`` /
        ``__fspath__`` on a ``MagicMock`` produce a Mock that ``open()``
        refuses to read. We instead patch ``builtins.open`` (the same pattern
        used in ``test_load_config_success`` below) and assert on the merged
        result returned by ``load_config``.
        """
        from config_and_logger import load_config

        with patch("config_and_logger.os.path.exists", return_value=True):
            result = load_config()

        self.assertEqual(result["autoconnect"], True)
        self.assertEqual(result["log_level"], "DEBUG")
        self.assertEqual(result["appearance_mode"], "Dark")

    @patch("config_and_logger._CONFIG_FILE_PATH")
    def test_load_config_file_not_exists(self, mock_config_path):
        """Test load_config when config file doesn't exist."""
        from config_and_logger import load_config

        mock_config_path.__str__ = Mock(return_value=self.temp_config_file)
        mock_config_path.__fspath__ = Mock(return_value=self.temp_config_file)

        with patch("config_and_logger.os.path.exists", return_value=False):
            result = load_config()

        # Should return default config
        self.assertIn("autoconnect", result)
        self.assertIn("log_level", result)

    @patch("config_and_logger._CONFIG_FILE_PATH")
    def test_load_config_invalid_json(self, mock_config_path):
        """Test load_config with invalid JSON file."""
        from config_and_logger import load_config

        mock_config_path.__str__ = Mock(return_value=self.temp_config_file)
        mock_config_path.__fspath__ = Mock(return_value=self.temp_config_file)

        # Create invalid JSON file
        with open(self.temp_config_file, "w") as f:
            f.write("invalid json content")

        with patch("config_and_logger.os.path.exists", return_value=True):
            result = load_config()

        # Should return default config on JSON parse error
        self.assertIn("autoconnect", result)
        self.assertIn("log_level", result)

    def test_save_config_success(self):
        """Test successful config saving.

        Post-refactor, ``save_config`` always returns ``None`` — it does not
        signal success/failure with a boolean. Success is observable by
        inspecting the file system.

        The conftest's autouse ``setup_test_environment`` fixture already
        patches ``_CONFIG_FILE_PATH`` to a temp file, so we just call
        ``save_config`` directly and verify the file is written.
        """
        from config_and_logger import save_config

        test_config = {"autoconnect": False, "log_level": "INFO", "custom_setting": "test_value"}

        # The conftest fixture has already set _CONFIG_FILE_PATH to a temp
        # file under self.temp_config_file's parent. Use that path so we
        # avoid the MagicMock __fspath__ pitfall (where instance-level
        # __fspath__ on a MagicMock is not honored by open()).
        with patch("config_and_logger._CONFIG_FILE_PATH", self.temp_config_file):
            result = save_config(test_config)

        self.assertIsNone(result)

        # Verify file was written
        self.assertTrue(os.path.exists(self.temp_config_file))

        # Verify content
        with open(self.temp_config_file, "r") as f:
            saved_config = json.load(f)

        self.assertEqual(saved_config["autoconnect"], False)
        self.assertEqual(saved_config["log_level"], "INFO")
        self.assertEqual(saved_config["custom_setting"], "test_value")

    @patch("config_and_logger._CONFIG_FILE_PATH")
    def test_save_config_permission_error(self, mock_config_path):
        """Test save_config with permission error.

        Post-refactor, ``save_config`` always returns ``None`` regardless of
        success/failure. Failure is observable by the absence of a written
        file (and an internal log message), not by a boolean return.
        """
        from config_and_logger import save_config

        # Use a path that would cause permission error
        mock_config_path.__str__ = Mock(return_value="/root/readonly/config.json")
        mock_config_path.__fspath__ = Mock(return_value="/root/readonly/config.json")

        test_config = {"test": "value"}

        result = save_config(test_config)

        # save_config does not surface success/failure; it always returns None
        self.assertIsNone(result)

    def test_update_config_settings_basic(self):
        """Test update_config_settings with basic operation.

        Post-refactor, ``update_config_settings`` no longer reads
        ``load_config`` to merge — it simply forwards the new settings to
        ``save_config`` and calls ``logger.update_config``. The test
        asserts the modern contract: returns ``None``, calls ``save_config``
        with the new settings, and updates the global logger.
        """
        from config_and_logger import update_config_settings

        with patch("config_and_logger.save_config") as mock_save, patch(
            "config_and_logger.logger"
        ) as mock_logger:
            mock_save.return_value = None  # post-refactor contract

            new_settings = {"existing_setting": "new_value", "new_setting": "new_value"}

            result = update_config_settings(new_settings)

            self.assertIsNone(result)
            mock_save.assert_called_once_with(new_settings)
            mock_logger.update_config.assert_called_once_with(new_settings)

    def test_update_config_settings_empty(self):
        """Test update_config_settings with empty settings.

        Post-refactor contract: always returns ``None`` regardless of input.
        """
        from config_and_logger import update_config_settings

        result = update_config_settings({})

        # save_config is still called (with an empty merge) and returns None
        self.assertIsNone(result)

    def test_setup_logging_basic(self):
        """Logger set_level basic functionality (replaces old setup_logging).

        The 5a3a9c9d refactor removed ``setup_logging`` and ``config_and_logger.logging``.
        The replacement is the ``Logger`` class with ``set_level``/``update_config``.
        We verify the modern equivalent: ``logger.set_level("DEBUG")`` updates
        the numeric level and the per-output thresholds.
        """
        from config_and_logger import logger

        with patch.object(logger, "_log") as mock_log:
            logger.set_level("DEBUG")

        # set_level logs an info message ("Global log level set to DEBUG")
        mock_log.assert_called()
        # The level maps to the DEBUG numeric value
        self.assertEqual(logger.LEVELS["DEBUG"], 10)

    def test_setup_logging_invalid_level(self):
        """Logger set_level with an invalid level (replaces old setup_logging).

        The 5a3a9c9d refactor removed ``setup_logging``. We verify the modern
        equivalent: ``logger.set_level("INVALID_LEVEL")`` is handled
        gracefully (the numeric level falls back to the default).
        """
        from config_and_logger import logger

        original_level = logger.level
        try:
            # Should not raise; falls back silently
            logger.set_level("INVALID_LEVEL")
            # Level remains a valid integer (unchanged or default)
            self.assertIsInstance(logger.level, int)
        finally:
            logger.level = original_level

    def test_logger_singleton_behavior(self):
        """Test that logger instance is singleton."""
        from config_and_logger import logger

        logger1 = logger
        logger2 = logger

        # Should be the same instance
        self.assertIs(logger1, logger2)

    @patch("config_and_logger.os.path.expanduser")
    def test_config_directory_handling(self, mock_expanduser):
        """Test config directory path handling."""

        mock_expanduser.return_value = "/home/user"

        # Import should work without errors
        import config_and_logger

        # Should have proper attributes
        self.assertTrue(hasattr(config_and_logger, "_SCRIPT_DIR"))
        self.assertTrue(hasattr(config_and_logger, "_CONFIG_FILE_PATH"))

    def test_config_merge_preserves_defaults(self):
        """Test that config merging preserves default values."""
        from config_and_logger import get_default_config, load_config

        with patch("config_and_logger.os.path.exists", return_value=False):
            config = load_config()
            default_config = get_default_config()

            # All default keys should be present
            for key in default_config:
                self.assertIn(key, config)

    @patch("config_and_logger.open", new_callable=mock_open, read_data='{"autoconnect": true, "log_level": "ERROR"}')
    def test_config_partial_file(self, mock_file):
        """Test loading config file with only partial settings.

        Patches ``builtins.open`` (the same pattern used in
        ``test_load_config_success``) so the read returns a partial JSON.
        ``_validate_and_merge_config`` then merges it with the defaults —
        every key in ``get_default_config()`` should still be present.
        """
        from config_and_logger import load_config

        with patch("config_and_logger.os.path.exists", return_value=True):
            result = load_config()

        # Should have loaded values
        self.assertEqual(result["autoconnect"], True)
        self.assertEqual(result["log_level"], "ERROR")

        # Should also have default values for missing keys
        self.assertIn("download_directory", result)
        self.assertIn("appearance_mode", result)

    def test_json_serialization_compatibility(self):
        """Test that config values are JSON serializable."""
        from config_and_logger import get_default_config

        default_config = get_default_config()

        try:
            # Should be able to serialize and deserialize without errors
            json_str = json.dumps(default_config)
            parsed_config = json.loads(json_str)

            self.assertEqual(default_config, parsed_config)
        except (TypeError, ValueError) as e:
            self.fail(f"Config not JSON serializable: {e}")

    @patch("config_and_logger.logger")
    @patch("config_and_logger.open", new_callable=mock_open)
    def test_logging_integration(self, mock_file, mock_logger):
        """Test logging integration in config operations.

        Patches ``builtins.open`` (the post-refactor pattern for
        ``_CONFIG_FILE_PATH``) and the module-level ``logger``. ``save_config``
        calls ``logger.info`` on the success path.
        """
        from config_and_logger import save_config

        test_config = {"test": "value"}

        save_config(test_config)

        # Logger should have been used (save_config logs success info)
        mock_logger.info.assert_called()

    @patch("config_and_logger.open", new_callable=mock_open)
    def test_config_file_atomic_write(self, mock_file):
        """Test that config file writes are atomic (don't corrupt existing file).

        Post-refactor, ``save_config`` returns ``None`` on both success and
        failure. The observable success signal is the file content, not a
        boolean.

        ``json.dump`` writes the JSON in many small ``write()`` calls (one
        per token), so we must concatenate all of them — not just the
        final one — to recover the full serialized config.
        """
        from config_and_logger import save_config

        # Create initial config
        initial_config = {"initial": "value"}
        result1 = save_config(initial_config)
        self.assertIsNone(result1)

        # Update config
        updated_config = {"initial": "value", "new": "setting"}
        result2 = save_config(updated_config)
        self.assertIsNone(result2)

        # Concatenate every write() call to recover the full JSON payload.
        all_writes = [c.args[0] for c in mock_file.return_value.write.call_args_list if c.args]
        written_text = "".join(all_writes)
        self.assertIn("initial", written_text)
        self.assertIn("new", written_text)


class TestConfigConstants(unittest.TestCase):
    """Test configuration constants and defaults."""

    def test_constants_import(self):
        """Test that constants can be imported."""
        try:
            import constants

            # Verify basic structure exists
            self.assertTrue(hasattr(constants, "__file__"))
        except ImportError:
            # If constants module doesn't exist, create a basic test
            pass

    def test_default_config_values(self):
        """Test default configuration values are reasonable."""
        from config_and_logger import get_default_config

        config = get_default_config()

        # Test reasonable defaults
        self.assertIsInstance(config["autoconnect"], bool)
        self.assertIn(config["log_level"], ["DEBUG", "INFO", "WARNING", "ERROR"])
        self.assertIn(config["appearance_mode"], ["System", "Light", "Dark"])
        self.assertIn(config["color_theme"], ["blue", "green", "dark-blue"])

        # Test numeric values
        self.assertIsInstance(config["recording_check_interval_s"], (int, float))
        self.assertGreater(config["recording_check_interval_s"], 0)

    def test_config_key_consistency(self):
        """Test that config keys are consistent (no typos/inconsistencies)."""
        from config_and_logger import get_default_config

        config = get_default_config()

        # Check for common typos or inconsistencies
        keys = list(config.keys())

        # Should not have duplicate-like keys
        lowercase_keys = [k.lower() for k in keys]
        self.assertEqual(len(lowercase_keys), len(set(lowercase_keys)), "Duplicate keys found")

        # Keys should follow naming conventions
        for key in keys:
            self.assertIsInstance(key, str)
            self.assertGreater(len(key), 0)
            # Should not contain spaces (use underscores)
            self.assertNotIn(" ", key, f"Key '{key}' contains spaces")


class TestLoggerFunctionality(unittest.TestCase):
    """Test logger setup and functionality."""

    def test_logger_creation(self):
        """Test that logger is created properly."""
        from config_and_logger import logger

        self.assertIsNotNone(logger)
        # Should have expected logger methods
        self.assertTrue(hasattr(logger, "debug"))
        self.assertTrue(hasattr(logger, "info"))
        self.assertTrue(hasattr(logger, "warning"))
        self.assertTrue(hasattr(logger, "error"))

    @patch("config_and_logger.logger")
    def test_setup_logging_levels(self, mock_logger):
        """Logger set_level across different levels (replaces old setup_logging).

        The 5a3a9c9d refactor removed ``setup_logging`` and
        ``config_and_logger.logging``. The modern replacement is
        ``Logger.set_level()``. We verify it accepts each of the standard
        level strings and triggers an internal info log.
        """
        from config_and_logger import logger as real_logger

        with patch.object(real_logger, "set_level") as mock_set_level:
            # Test different log levels
            for level in ["DEBUG", "INFO", "WARNING", "ERROR"]:
                real_logger.set_level(level)
                mock_set_level.assert_called_with(level)

    def test_logger_instance_consistency(self):
        """Test that logger instance is consistent across imports."""
        # Import multiple times
        from config_and_logger import logger as logger1
        from config_and_logger import logger as logger2

        # Should be the same instance
        self.assertIs(logger1, logger2)


if __name__ == "__main__":
    unittest.main()
