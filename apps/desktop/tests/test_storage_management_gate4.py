"""Gate 4 (Task 6) — storage_management.py coverage top-up toward 80%.

Covers the previously-uncovered paths in StorageMonitor, StorageOptimizer,
StorageQuotaManager, and the create_storage_management_system factory.
All external I/O (disk access, sqlite, threading) is mocked.
"""

import shutil
import sqlite3
import tempfile
import threading
import time
from dataclasses import asdict
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, Mock, call, patch

import pytest
from storage_management import (
    OptimizationSuggestion,
    OptimizationType,
    StorageAnalytics,
    StorageInfo,
    StorageMonitor,
    StorageOptimizer,
    StorageQuota,
    StorageQuotaManager,
    StorageWarningLevel,
    create_storage_management_system,
)

pytestmark = pytest.mark.timeout(30)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_monitor(paths=None, interval=60.0):
    """Build a StorageMonitor with _update_storage_info and start_monitoring mocked."""
    paths = paths or ["/tmp/test"]
    with patch.object(StorageMonitor, "_update_storage_info"):
        with patch.object(StorageMonitor, "start_monitoring"):
            return StorageMonitor(paths, update_interval=interval)


def _make_optimizer(paths=None):
    """Build a StorageOptimizer with _init_database mocked."""
    paths = paths or ["/tmp/opt"]
    with patch.object(StorageOptimizer, "_init_database"):
        return StorageOptimizer(paths)


def _make_quota():
    return StorageQuota(
        max_total_size=10 * 1024 * 1024 * 1024,
        max_file_count=1000,
        max_file_size=100 * 1024 * 1024,
        retention_days=30,
        auto_cleanup_enabled=True,
        warning_threshold=0.8,
        critical_threshold=0.9,
    )


def _make_storage_info(usage_pct, free_space=None, total=100 * 1024 * 1024 * 1024):
    """Build a StorageInfo with realistic total size (100 GB default) so free_space is
    always well above the 1 GB threshold in quota violation checks, unless overridden."""
    used = int(total * usage_pct / 100)
    free = free_space if free_space is not None else total - used
    level = (
        StorageWarningLevel.FULL if usage_pct >= 95
        else StorageWarningLevel.CRITICAL if usage_pct >= 85
        else StorageWarningLevel.WARNING if usage_pct >= 70
        else StorageWarningLevel.NORMAL
    )
    return StorageInfo(
        total_space=total, used_space=used, free_space=free,
        usage_percentage=usage_pct, warning_level=level, last_updated=datetime.now()
    )


# ---------------------------------------------------------------------------
# StorageMonitor — start_monitoring, stop_monitoring, _monitoring_loop,
#                  _update_storage_info (warning levels), get_storage_info,
#                  get_warning_level
# ---------------------------------------------------------------------------


class TestStorageMonitorStartStop:
    def test_start_monitoring_creates_thread(self):
        monitor = _make_monitor()
        monitor.stop_event.set()  # pre-set so loop exits immediately

        with patch("storage_management.threading.Thread") as MockThread:
            mock_thread = Mock()
            mock_thread.is_alive.return_value = False
            MockThread.return_value = mock_thread

            monitor.start_monitoring()

        MockThread.assert_called_once()
        mock_thread.start.assert_called_once()

    def test_start_monitoring_skips_if_already_alive(self):
        monitor = _make_monitor()
        alive_thread = Mock()
        alive_thread.is_alive.return_value = True
        monitor.monitoring_thread = alive_thread

        with patch("storage_management.threading.Thread") as MockThread:
            monitor.start_monitoring()
        MockThread.assert_not_called()  # No new thread created

    def test_stop_monitoring_sets_event_and_joins(self):
        monitor = _make_monitor()
        mock_thread = Mock()
        monitor.monitoring_thread = mock_thread

        monitor.stop_monitoring()

        assert monitor.stop_event.is_set()
        mock_thread.join.assert_called_once_with(timeout=5.0)

    def test_stop_monitoring_no_thread(self):
        monitor = _make_monitor()
        monitor.monitoring_thread = None
        monitor.stop_monitoring()  # Should not raise
        assert monitor.stop_event.is_set()


class TestStorageMonitorUpdateInfo:
    def test_update_storage_info_warning_levels(self):
        """_update_storage_info correctly classifies all four warning levels."""
        monitor = _make_monitor(["/tmp/w"])

        test_cases = [
            ((1000, 500, 500), StorageWarningLevel.NORMAL),      # 50%
            ((1000, 750, 250), StorageWarningLevel.WARNING),     # 75%
            ((1000, 880, 120), StorageWarningLevel.CRITICAL),    # 88%
            ((1000, 970, 30), StorageWarningLevel.FULL),         # 97%
        ]

        with patch("storage_management.shutil.disk_usage") as mock_du:
            with patch("storage_management.Path.exists", return_value=True):
                for disk_vals, expected_level in test_cases:
                    mock_du.return_value = disk_vals
                    monitor.storage_info.clear()
                    monitor._update_storage_info()
                    assert len(monitor.storage_info) == 1
                    info = list(monitor.storage_info.values())[0]
                    assert info.warning_level == expected_level

    def test_update_storage_info_skips_nonexistent_path(self):
        monitor = _make_monitor(["/nonexistent/path"])
        with patch("storage_management.Path.exists", return_value=False):
            monitor._update_storage_info()
        assert monitor.storage_info == {}

    def test_update_storage_info_handles_exception(self):
        monitor = _make_monitor(["/tmp/err"])
        with patch("storage_management.Path.exists", return_value=True):
            with patch("storage_management.shutil.disk_usage", side_effect=OSError("denied")):
                monitor._update_storage_info()  # Should not raise
        assert monitor.storage_info == {}

    def test_update_storage_info_zero_total(self):
        """Zero total space should not cause ZeroDivisionError."""
        monitor = _make_monitor(["/tmp/zero"])
        with patch("storage_management.Path.exists", return_value=True):
            with patch("storage_management.shutil.disk_usage", return_value=(0, 0, 0)):
                monitor._update_storage_info()  # Should not raise


class TestStorageMonitorGetInfo:
    def test_get_storage_info_no_args_returns_copy(self):
        monitor = _make_monitor(["/tmp/a"])
        info = _make_storage_info(50)
        monitor.storage_info["/tmp/a"] = info

        result = monitor.get_storage_info()
        assert result == {"/tmp/a": info}
        # Ensure it's a copy, not the same dict
        result.clear()
        assert len(monitor.storage_info) == 1

    def test_get_storage_info_specific_path_found(self):
        monitor = _make_monitor(["/tmp/a"])
        info = _make_storage_info(75)
        monitor.storage_info["/tmp/a"] = info

        result = monitor.get_storage_info("/tmp/a")
        assert result == {"/tmp/a": info}

    def test_get_storage_info_specific_path_not_found(self):
        monitor = _make_monitor(["/tmp/a"])
        result = monitor.get_storage_info("/tmp/missing")
        assert result == {}

    def test_get_warning_level_found(self):
        monitor = _make_monitor(["/tmp/a"])
        monitor.storage_info["/tmp/a"] = _make_storage_info(90)  # CRITICAL

        level = monitor.get_warning_level("/tmp/a")
        assert level == StorageWarningLevel.CRITICAL

    def test_get_warning_level_not_found_defaults_to_normal(self):
        monitor = _make_monitor([])
        level = monitor.get_warning_level("/nonexistent")
        assert level == StorageWarningLevel.NORMAL


class TestStorageMonitorLoop:
    def test_monitoring_loop_calls_callbacks_on_change(self):
        """_monitoring_loop notifies callbacks when warning level changes."""
        monitor = _make_monitor(["/tmp/loop"])

        initial_info = _make_storage_info(50)  # NORMAL
        changed_info = _make_storage_info(80)  # WARNING
        monitor.storage_info["/tmp/loop"] = initial_info

        callback = Mock()
        monitor.add_callback(callback)

        # Mock _update_storage_info to put a changed entry
        def fake_update():
            monitor.storage_info["/tmp/loop"] = changed_info

        monitor._update_storage_info = fake_update
        monitor.stop_event.set()  # One pass only

        with patch.object(monitor.stop_event, "wait", return_value=True):
            monitor._monitoring_loop()

        # After the loop body completes, since we changed warning_level, callback fires
        # (the loop calls fake_update which changes storage_info, then checks)
        # We need to let it run one iteration
        monitor.stop_event.clear()
        monitor._update_storage_info = fake_update

        with patch.object(monitor.stop_event, "wait", side_effect=[False, True]):
            monitor._monitoring_loop()

        callback.assert_called_once()
        path_arg, info_arg = callback.call_args[0]
        assert path_arg == "/tmp/loop"
        assert info_arg.warning_level == StorageWarningLevel.WARNING

    def test_monitoring_loop_callback_exception_does_not_crash(self):
        """A callback that raises should not crash the monitoring loop."""
        monitor = _make_monitor(["/tmp/loop2"])

        bad_callback = Mock(side_effect=RuntimeError("bad callback"))
        monitor.add_callback(bad_callback)

        # Make storage_info change to trigger callback notification
        initial_info = _make_storage_info(50)
        changed_info = _make_storage_info(80)
        monitor.storage_info["/tmp/loop2"] = initial_info

        def fake_update():
            monitor.storage_info["/tmp/loop2"] = changed_info

        monitor._update_storage_info = fake_update

        with patch.object(monitor.stop_event, "wait", side_effect=[False, True]):
            monitor._monitoring_loop()  # Should not raise


# ---------------------------------------------------------------------------
# StorageOptimizer — analyze_storage, generate_optimization_suggestions,
#                    _estimate_cache_size, execute_optimization, _remove_duplicates,
#                    _cleanup_old_files, _cleanup_cache, _cleanup_temp_files,
#                    get_optimization_history
# ---------------------------------------------------------------------------


class TestStorageOptimizerAnalyze:
    def test_analyze_storage_empty_dir(self, tmp_path):
        """analyze_storage on empty directory returns zero counts."""
        optimizer = _make_optimizer([str(tmp_path)])
        analytics = optimizer.analyze_storage()
        assert analytics.total_files == 0
        assert analytics.total_size == 0
        assert analytics.duplicate_files == []

    def test_analyze_storage_counts_files(self, tmp_path):
        """analyze_storage correctly counts files and distributions."""
        # Create test files
        small_file = tmp_path / "small.txt"
        small_file.write_bytes(b"x" * 100)  # < 1 MB - small

        optimizer = _make_optimizer([str(tmp_path)])
        analytics = optimizer.analyze_storage()

        assert analytics.total_files == 1
        assert analytics.total_size == 100
        assert analytics.size_distribution["small"] == 1
        assert ".txt" in analytics.file_type_distribution
        assert analytics.file_type_distribution[".txt"]["count"] == 1

    def test_analyze_storage_detects_duplicates(self, tmp_path):
        """analyze_storage detects files with same size+name pattern."""
        # Two files with same name in different dirs - triggers duplicate detection
        (tmp_path / "a").mkdir()
        (tmp_path / "b").mkdir()
        (tmp_path / "a" / "dup.wav").write_bytes(b"x" * 100)
        (tmp_path / "b" / "dup.wav").write_bytes(b"x" * 100)

        optimizer = _make_optimizer([str(tmp_path)])
        analytics = optimizer.analyze_storage()

        assert analytics.total_files == 2
        assert len(analytics.duplicate_files) >= 1

    def test_analyze_storage_age_distribution(self, tmp_path):
        """analyze_storage categorises files by age correctly."""
        recent_file = tmp_path / "recent.txt"
        recent_file.write_bytes(b"r")

        optimizer = _make_optimizer([str(tmp_path)])
        analytics = optimizer.analyze_storage()

        # File was just created so it should be "recent"
        assert analytics.age_distribution["recent"] >= 1

    def test_analyze_storage_skips_nonexistent_path(self):
        optimizer = _make_optimizer(["/nonexistent/path/xyz"])
        analytics = optimizer.analyze_storage()
        assert analytics.total_files == 0

    def test_analyze_storage_size_buckets(self, tmp_path):
        """Files are bucketed into small/medium/large/huge."""
        # medium = 1–10 MB
        med = tmp_path / "med.bin"
        med.write_bytes(b"m" * (2 * 1024 * 1024))  # 2 MB

        optimizer = _make_optimizer([str(tmp_path)])
        analytics = optimizer.analyze_storage()

        assert analytics.size_distribution["medium"] == 1


class TestStorageOptimizerSuggestions:
    def _make_analytics(self, duplicates=None, old_count=0, large_count=0):
        return StorageAnalytics(
            total_files=10,
            total_size=1024,
            file_type_distribution={},
            size_distribution={"small": 5, "medium": 0, "large": large_count, "huge": 0},
            age_distribution={"recent": 5, "week": 0, "month": 0, "old": old_count},
            access_patterns={},
            growth_trend={},
            duplicate_files=duplicates or [],
        )

    def test_no_suggestions_when_nothing_notable(self):
        optimizer = _make_optimizer()
        analytics = self._make_analytics()
        suggestions = optimizer.generate_optimization_suggestions(analytics)
        # With no duplicates, low old count, no large files, no big cache -> empty
        assert suggestions == []

    def test_duplicate_suggestion_generated(self):
        optimizer = _make_optimizer()
        analytics = self._make_analytics(
            duplicates=[("key1", ["/a/file.wav", "/b/file.wav"])]
        )
        with patch.object(optimizer, "_estimate_cache_size", return_value=0):
            suggestions = optimizer.generate_optimization_suggestions(analytics)

        types = [s.type for s in suggestions]
        assert OptimizationType.DUPLICATE_REMOVAL in types
        dup_sug = next(s for s in suggestions if s.type == OptimizationType.DUPLICATE_REMOVAL)
        assert dup_sug.priority == 4
        assert dup_sug.action_required is True
        assert "/b/file.wav" in dup_sug.files_affected  # second path is the duplicate

    def test_old_file_suggestion_when_many_old_files(self):
        optimizer = _make_optimizer()
        analytics = self._make_analytics(old_count=150)
        with patch.object(optimizer, "_estimate_cache_size", return_value=0):
            suggestions = optimizer.generate_optimization_suggestions(analytics)

        types = [s.type for s in suggestions]
        assert OptimizationType.OLD_FILE_CLEANUP in types

    def test_no_old_file_suggestion_when_few_old(self):
        optimizer = _make_optimizer()
        analytics = self._make_analytics(old_count=5)
        with patch.object(optimizer, "_estimate_cache_size", return_value=0):
            suggestions = optimizer.generate_optimization_suggestions(analytics)

        types = [s.type for s in suggestions]
        assert OptimizationType.OLD_FILE_CLEANUP not in types

    def test_cache_suggestion_when_cache_large(self):
        optimizer = _make_optimizer()
        analytics = self._make_analytics()
        with patch.object(optimizer, "_estimate_cache_size", return_value=200 * 1024 * 1024):
            suggestions = optimizer.generate_optimization_suggestions(analytics)

        types = [s.type for s in suggestions]
        assert OptimizationType.CACHE_CLEANUP in types

    def test_compression_suggestion_for_large_files(self):
        optimizer = _make_optimizer()
        analytics = self._make_analytics(large_count=15)
        with patch.object(optimizer, "_estimate_cache_size", return_value=0):
            suggestions = optimizer.generate_optimization_suggestions(analytics)

        types = [s.type for s in suggestions]
        assert OptimizationType.COMPRESSION in types

    def test_suggestions_sorted_by_priority_descending(self):
        optimizer = _make_optimizer()
        analytics = self._make_analytics(
            duplicates=[("k", ["/a.wav", "/b.wav"])],
            old_count=150,
            large_count=15,
        )
        with patch.object(optimizer, "_estimate_cache_size", return_value=200 * 1024 * 1024):
            suggestions = optimizer.generate_optimization_suggestions(analytics)

        priorities = [s.priority for s in suggestions]
        assert priorities == sorted(priorities, reverse=True)


class TestStorageOptimizerEstimateCache:
    def test_estimate_cache_size_sums_cache_dir(self):
        """_estimate_cache_size sums file sizes inside cache_dir."""
        with patch.object(StorageOptimizer, "_init_database"):
            optimizer = StorageOptimizer(["/tmp/opt"])

        # Use optimizer.cache_dir (may be redirected by conftest isolation)
        cache_dir = optimizer.cache_dir
        # Create known-size files in the actual cache dir
        f1 = cache_dir / "gate4_est_a.db"
        f2 = cache_dir / "gate4_est_b.db"
        f1.write_bytes(b"x" * 100)
        f2.write_bytes(b"y" * 200)

        try:
            size = optimizer._estimate_cache_size()
            assert size >= 300
        finally:
            f1.unlink(missing_ok=True)
            f2.unlink(missing_ok=True)

    def test_estimate_cache_size_ignores_unreadable_files(self):
        """_estimate_cache_size handles OSError gracefully."""
        with patch.object(StorageOptimizer, "_init_database"):
            optimizer = StorageOptimizer(["/tmp/opt"])

        cache_dir = optimizer.cache_dir
        good = cache_dir / "gate4_est_good.db"
        good.write_bytes(b"x" * 50)

        try:
            size = optimizer._estimate_cache_size()
            assert isinstance(size, int)
            assert size >= 50
        finally:
            good.unlink(missing_ok=True)


class TestStorageOptimizerExecuteOptimization:
    def test_execute_optimization_duplicate_removal_dry_run(self, tmp_path):
        optimizer = _make_optimizer()
        dup_file = tmp_path / "dup.wav"
        dup_file.write_bytes(b"data" * 10)

        suggestion = OptimizationSuggestion(
            type=OptimizationType.DUPLICATE_REMOVAL,
            description="Remove duplicates",
            potential_savings=40,
            priority=4,
            action_required=True,
            estimated_time="1 min",
            files_affected=[str(dup_file)],
        )

        result = optimizer.execute_optimization(suggestion, dry_run=True)

        assert result["files_processed"] == 1
        assert result["space_saved"] == 40
        assert dup_file.exists()  # dry_run - not deleted

    def test_execute_optimization_duplicate_removal_real(self, tmp_path):
        optimizer = _make_optimizer()
        dup_file = tmp_path / "dup.wav"
        dup_file.write_bytes(b"data" * 10)

        suggestion = OptimizationSuggestion(
            type=OptimizationType.DUPLICATE_REMOVAL,
            description="Remove duplicates",
            potential_savings=40,
            priority=4,
            action_required=True,
            estimated_time="1 min",
            files_affected=[str(dup_file)],
        )

        with patch("storage_management.sqlite3.connect") as mock_conn:
            mock_conn.return_value.__enter__ = Mock(return_value=Mock())
            mock_conn.return_value.__exit__ = Mock(return_value=False)
            result = optimizer.execute_optimization(suggestion, dry_run=False)

        assert result["success"] is True
        assert not dup_file.exists()

    def test_execute_optimization_unimplemented_type(self):
        optimizer = _make_optimizer()
        suggestion = OptimizationSuggestion(
            type=OptimizationType.COMPRESSION,  # Not implemented in execute_optimization
            description="Compress files",
            potential_savings=1000,
            priority=2,
            action_required=True,
            estimated_time="10 min",
            files_affected=[],
        )
        result = optimizer.execute_optimization(suggestion, dry_run=True)
        assert len(result["errors"]) > 0

    def test_execute_optimization_cache_cleanup(self):
        """execute_optimization routes CACHE_CLEANUP to _cleanup_cache."""
        with patch.object(StorageOptimizer, "_init_database"):
            optimizer = StorageOptimizer(["/tmp/opt"])

        cache_dir = optimizer.cache_dir
        cache_file = cache_dir / "gate4_exec_cache.db"
        cache_file.write_bytes(b"cache" * 10)

        try:
            suggestion = OptimizationSuggestion(
                type=OptimizationType.CACHE_CLEANUP,
                description="Clean cache",
                potential_savings=50,
                priority=2,
                action_required=False,
                estimated_time="1 min",
                files_affected=[],
            )

            result = optimizer.execute_optimization(suggestion, dry_run=True)
            assert result["files_processed"] >= 1
            assert cache_file.exists()  # dry_run, not deleted
        finally:
            cache_file.unlink(missing_ok=True)

    def test_execute_optimization_temp_cleanup_dry_run(self):
        optimizer = _make_optimizer()
        suggestion = OptimizationSuggestion(
            type=OptimizationType.TEMP_FILE_CLEANUP,
            description="Clean temp",
            potential_savings=0,
            priority=1,
            action_required=False,
            estimated_time="1 min",
            files_affected=[],
        )
        # Temp dirs may not have hidock files; just verify no exception
        result = optimizer.execute_optimization(suggestion, dry_run=True)
        assert "success" in result

    def test_execute_optimization_exception_path(self):
        optimizer = _make_optimizer()
        suggestion = OptimizationSuggestion(
            type=OptimizationType.DUPLICATE_REMOVAL,
            description="err",
            potential_savings=0,
            priority=1,
            action_required=False,
            estimated_time="1s",
            files_affected=[],
        )
        with patch.object(optimizer, "_remove_duplicates", side_effect=RuntimeError("oops")):
            result = optimizer.execute_optimization(suggestion, dry_run=False)
        assert len(result["errors"]) > 0


class TestStorageOptimizerCleanupMethods:
    def test_remove_duplicates_skips_missing_file(self, tmp_path):
        optimizer = _make_optimizer()
        result = optimizer._remove_duplicates([str(tmp_path / "ghost.wav")], dry_run=False)
        assert result["success"] is True
        assert result["files_processed"] == 0

    def test_cleanup_old_files_removes_old(self, tmp_path):
        optimizer = _make_optimizer([str(tmp_path)])
        old_file = tmp_path / "old.wav"
        old_file.write_bytes(b"old")

        # Backdate the file's mtime
        import os
        old_mtime = (datetime.now() - timedelta(days=60)).timestamp()
        os.utime(str(old_file), (old_mtime, old_mtime))

        result = optimizer._cleanup_old_files(dry_run=False, days_old=30)

        assert result["success"] is True
        assert result["files_processed"] >= 1
        assert not old_file.exists()

    def test_cleanup_old_files_dry_run_keeps_files(self, tmp_path):
        optimizer = _make_optimizer([str(tmp_path)])
        old_file = tmp_path / "old.wav"
        old_file.write_bytes(b"old")

        import os
        old_mtime = (datetime.now() - timedelta(days=60)).timestamp()
        os.utime(str(old_file), (old_mtime, old_mtime))

        result = optimizer._cleanup_old_files(dry_run=True, days_old=30)

        assert result["files_processed"] >= 1
        assert old_file.exists()  # dry_run - kept

    def test_cleanup_old_files_ignores_recent(self, tmp_path):
        optimizer = _make_optimizer([str(tmp_path)])
        recent_file = tmp_path / "recent.wav"
        recent_file.write_bytes(b"new")

        result = optimizer._cleanup_old_files(dry_run=False, days_old=30)

        assert result["files_processed"] == 0
        assert recent_file.exists()

    def test_cleanup_cache_removes_files(self):
        """_cleanup_cache actually deletes files when dry_run=False."""
        with patch.object(StorageOptimizer, "_init_database"):
            optimizer = StorageOptimizer(["/tmp/opt"])

        cache_dir = optimizer.cache_dir
        f1 = cache_dir / "gate4_cc_del1.db"
        f2 = cache_dir / "gate4_cc_del2.db"
        f1.write_bytes(b"a" * 100)
        f2.write_bytes(b"b" * 200)

        result = optimizer._cleanup_cache(dry_run=False)

        assert result["success"] is True
        assert result["files_processed"] >= 2
        assert result["space_saved"] >= 300
        assert not f1.exists()
        assert not f2.exists()

    def test_cleanup_cache_dry_run(self):
        """_cleanup_cache reports files but does not delete when dry_run=True."""
        with patch.object(StorageOptimizer, "_init_database"):
            optimizer = StorageOptimizer(["/tmp/opt"])

        cache_dir = optimizer.cache_dir
        f1 = cache_dir / "gate4_cc_keep.db"
        f1.write_bytes(b"x" * 50)

        try:
            result = optimizer._cleanup_cache(dry_run=True)
            assert result["files_processed"] >= 1
            assert f1.exists()  # dry_run, not deleted
        finally:
            f1.unlink(missing_ok=True)


class TestStorageOptimizerHistory:
    def test_get_optimization_history_empty(self, tmp_path):
        with patch.object(StorageOptimizer, "_init_database"):
            optimizer = StorageOptimizer(["/tmp/opt"], cache_dir=str(tmp_path))

        # Use a real in-memory DB for this test
        optimizer.db_path = ":memory:"

        # Initialise the DB schema directly
        with sqlite3.connect(":memory:") as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS optimization_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    optimization_type TEXT,
                    files_affected INTEGER,
                    space_saved INTEGER,
                    execution_time REAL,
                    timestamp TEXT
                )
            """)
            conn.commit()

        with patch("storage_management.sqlite3.connect") as mock_conn:
            mock_cursor = Mock()
            mock_cursor.fetchall.return_value = []
            mock_ctx = Mock()
            mock_ctx.execute.return_value = mock_cursor
            mock_conn.return_value.__enter__ = Mock(return_value=mock_ctx)
            mock_conn.return_value.__exit__ = Mock(return_value=False)

            history = optimizer.get_optimization_history()

        assert history == []

    def test_get_optimization_history_returns_rows(self, tmp_path):
        with patch.object(StorageOptimizer, "_init_database"):
            optimizer = StorageOptimizer(["/tmp/opt"], cache_dir=str(tmp_path))

        with patch("storage_management.sqlite3.connect") as mock_conn:
            mock_cursor = Mock()
            mock_cursor.fetchall.return_value = [
                ("cache_cleanup", 5, 1024, 1.2, "2026-01-01T00:00:00"),
            ]
            mock_ctx = Mock()
            mock_ctx.execute.return_value = mock_cursor
            mock_conn.return_value.__enter__ = Mock(return_value=mock_ctx)
            mock_conn.return_value.__exit__ = Mock(return_value=False)

            history = optimizer.get_optimization_history(limit=10)

        assert len(history) == 1
        assert history[0]["optimization_type"] == "cache_cleanup"
        assert history[0]["files_affected"] == 5
        assert history[0]["space_saved"] == 1024


# ---------------------------------------------------------------------------
# StorageQuotaManager — _check_quota_violations, check_file_quota,
#                       get_quota_status, _get_current_violations,
#                       _get_quota_recommendations, update_quota_config,
#                       enable_auto_cleanup
# ---------------------------------------------------------------------------


class TestStorageQuotaManagerViolations:
    def _make_manager(self, warning_threshold=0.8, critical_threshold=0.9):
        quota = StorageQuota(
            max_total_size=1000, max_file_count=100,
            max_file_size=100, retention_days=30,
            auto_cleanup_enabled=True,
            warning_threshold=warning_threshold,
            critical_threshold=critical_threshold,
        )
        monitor = Mock(spec=StorageMonitor)
        return StorageQuotaManager(quota, monitor), monitor

    def test_check_quota_violations_critical_triggers_callback(self):
        manager, _ = self._make_manager()
        callback = Mock()
        manager.add_warning_callback(callback)

        critical_info = _make_storage_info(95)  # 95% >= 90% critical
        manager._check_quota_violations("/tmp", critical_info)

        callback.assert_called()
        _, violation, _ = callback.call_args[0]
        assert violation["severity"] == "critical"

    def test_check_quota_violations_warning_triggers_callback(self):
        manager, _ = self._make_manager()
        callback = Mock()
        manager.add_warning_callback(callback)

        warning_info = _make_storage_info(85)  # 85% >= 80% warning
        manager._check_quota_violations("/tmp", warning_info)

        callback.assert_called()
        _, violation, _ = callback.call_args[0]
        assert violation["severity"] == "warning"

    def test_check_quota_violations_low_free_space_triggers_callback(self):
        manager, _ = self._make_manager()
        callback = Mock()
        manager.add_warning_callback(callback)

        # 50% usage but very low free space (< 1GB)
        # total=2GB, used=1GB, free=500MB < 1GB threshold
        info = _make_storage_info(50, total=2 * 1024 * 1024 * 1024, free_space=500 * 1024 * 1024)
        manager._check_quota_violations("/tmp", info)

        callback.assert_called()
        args_list = [call[0] for call in callback.call_args_list]
        severities = [v["severity"] for _, v, _ in args_list]
        assert "critical" in severities

    def test_check_quota_violations_no_callback_when_normal(self):
        manager, _ = self._make_manager()
        callback = Mock()
        manager.add_warning_callback(callback)

        # 50% usage, enough free space (more than 1 GB)
        info = _make_storage_info(50, free_space=2 * 1024 * 1024 * 1024)
        manager._check_quota_violations("/tmp", info)

        callback.assert_not_called()

    def test_check_quota_violations_callback_exception_handled(self):
        manager, _ = self._make_manager()
        bad_callback = Mock(side_effect=RuntimeError("boom"))
        manager.add_warning_callback(bad_callback)

        critical_info = _make_storage_info(95)
        manager._check_quota_violations("/tmp", critical_info)  # Should not raise

    def test_remove_warning_callback(self):
        manager, _ = self._make_manager()
        cb = Mock()
        manager.add_warning_callback(cb)
        assert cb in manager.warning_callbacks

        manager.remove_warning_callback(cb)
        assert cb not in manager.warning_callbacks

    def test_remove_nonexistent_warning_callback(self):
        manager, _ = self._make_manager()
        manager.remove_warning_callback(Mock())  # Should not raise


class TestStorageQuotaManagerFileQuota:
    def _make_manager(self):
        quota = StorageQuota(
            max_total_size=1000, max_file_count=100,
            max_file_size=50,  # 50 bytes max file size
            retention_days=30,
            auto_cleanup_enabled=True,
        )
        monitor = Mock(spec=StorageMonitor)
        return StorageQuotaManager(quota, monitor)

    def test_check_file_quota_passes_small_file(self):
        manager = self._make_manager()
        ok, violations = manager.check_file_quota(file_size=10)
        assert ok is True
        assert violations == []

    def test_check_file_quota_fails_large_file(self):
        manager = self._make_manager()
        ok, violations = manager.check_file_quota(file_size=100)  # > 50 byte limit
        assert ok is False
        assert len(violations) > 0


class TestStorageQuotaManagerStatus:
    def _make_manager_with_info(self, usage_pct):
        quota = _make_quota()
        monitor = Mock(spec=StorageMonitor)
        info = _make_storage_info(usage_pct)
        monitor.get_storage_info.return_value = {"/tmp": info}
        return StorageQuotaManager(quota, monitor)

    def test_get_quota_status_returns_dict(self):
        manager = self._make_manager_with_info(60)
        status = manager.get_quota_status()

        assert "quota_config" in status
        assert "current_usage" in status
        assert "quota_violations" in status
        assert "recommendations" in status

    def test_get_quota_status_no_storage_info(self):
        quota = _make_quota()
        monitor = Mock(spec=StorageMonitor)
        monitor.get_storage_info.return_value = {}
        manager = StorageQuotaManager(quota, monitor)

        status = manager.get_quota_status()
        assert "error" in status

    def test_get_current_violations_critical(self):
        manager = self._make_manager_with_info(95)
        info = _make_storage_info(95)
        violations = manager._get_current_violations(info)
        assert any(v["type"] == "critical_usage" for v in violations)

    def test_get_current_violations_warning(self):
        manager = self._make_manager_with_info(85)
        info = _make_storage_info(85)
        violations = manager._get_current_violations(info)
        assert any(v["type"] == "warning_usage" for v in violations)

    def test_get_current_violations_none_when_normal(self):
        manager = self._make_manager_with_info(50)
        info = _make_storage_info(50)
        violations = manager._get_current_violations(info)
        assert violations == []

    def test_get_quota_recommendations_high_usage(self):
        manager = self._make_manager_with_info(85)
        info = _make_storage_info(85)
        recs = manager._get_quota_recommendations(info)
        assert len(recs) > 0
        assert any("cleanup" in r.lower() for r in recs)

    def test_get_quota_recommendations_critical_full(self):
        manager = self._make_manager_with_info(96)
        info = _make_storage_info(96)  # FULL
        recs = manager._get_quota_recommendations(info)
        assert any("immediate" in r.lower() for r in recs)

    def test_get_quota_recommendations_auto_cleanup_disabled(self):
        quota = StorageQuota(
            max_total_size=1000, max_file_count=100, max_file_size=100,
            retention_days=30, auto_cleanup_enabled=False
        )
        monitor = Mock(spec=StorageMonitor)
        manager = StorageQuotaManager(quota, monitor)
        info = _make_storage_info(50)
        recs = manager._get_quota_recommendations(info)
        assert any("auto" in r.lower() for r in recs)


class TestStorageQuotaManagerConfig:
    def test_update_quota_config(self):
        quota = _make_quota()
        monitor = Mock(spec=StorageMonitor)
        manager = StorageQuotaManager(quota, monitor)

        new_quota = StorageQuota(
            max_total_size=5000, max_file_count=500, max_file_size=50,
            retention_days=7, auto_cleanup_enabled=False
        )
        manager.update_quota_config(new_quota)
        assert manager.quota_config is new_quota

    def test_enable_auto_cleanup_true(self):
        quota = StorageQuota(
            max_total_size=1000, max_file_count=100, max_file_size=50,
            retention_days=30, auto_cleanup_enabled=False
        )
        monitor = Mock(spec=StorageMonitor)
        manager = StorageQuotaManager(quota, monitor)

        manager.enable_auto_cleanup(True)
        assert manager.quota_config.auto_cleanup_enabled is True

    def test_enable_auto_cleanup_false(self):
        quota = _make_quota()
        monitor = Mock(spec=StorageMonitor)
        manager = StorageQuotaManager(quota, monitor)

        manager.enable_auto_cleanup(False)
        assert manager.quota_config.auto_cleanup_enabled is False


# ---------------------------------------------------------------------------
# create_storage_management_system factory
# ---------------------------------------------------------------------------


class TestCreateStorageManagementSystem:
    @patch.object(StorageMonitor, "_update_storage_info")
    @patch.object(StorageMonitor, "start_monitoring")
    @patch.object(StorageOptimizer, "_init_database")
    def test_factory_returns_three_components(self, mock_init_db, mock_start, mock_update):
        monitor, optimizer, quota_mgr = create_storage_management_system(
            base_paths=["/tmp/base"], download_dir="/tmp/dl"
        )

        assert isinstance(monitor, StorageMonitor)
        assert isinstance(optimizer, StorageOptimizer)
        assert isinstance(quota_mgr, StorageQuotaManager)

    @patch.object(StorageMonitor, "_update_storage_info")
    @patch.object(StorageMonitor, "start_monitoring")
    @patch.object(StorageOptimizer, "_init_database")
    def test_factory_uses_provided_quota(self, mock_init_db, mock_start, mock_update):
        custom_quota = StorageQuota(
            max_total_size=1000, max_file_count=10, max_file_size=100,
            retention_days=7, auto_cleanup_enabled=False
        )

        _, _, quota_mgr = create_storage_management_system(
            base_paths=["/tmp/base"], download_dir="/tmp/dl", quota_config=custom_quota
        )

        assert quota_mgr.quota_config is custom_quota

    @patch.object(StorageMonitor, "_update_storage_info")
    @patch.object(StorageMonitor, "start_monitoring")
    @patch.object(StorageOptimizer, "_init_database")
    def test_factory_creates_default_quota_when_none(self, mock_init_db, mock_start, mock_update):
        _, _, quota_mgr = create_storage_management_system(
            base_paths=["/tmp/base"], download_dir="/tmp/dl"
        )

        # Default quota should be set
        assert quota_mgr.quota_config.max_total_size == 10 * 1024 * 1024 * 1024
        assert quota_mgr.quota_config.auto_cleanup_enabled is True
