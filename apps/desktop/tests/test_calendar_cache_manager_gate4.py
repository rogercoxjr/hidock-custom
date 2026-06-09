"""
Gate 4 (Task 5) coverage for calendar_cache_manager.CalendarCacheManager.

Uses tmp_path (via autouse setup_test_environment in conftest) for disk isolation.
No USB, no Outlook, no network — pure JSON/in-memory cache logic.
"""
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


@pytest.fixture
def cache(tmp_path):
    """Fresh CalendarCacheManager backed by a tmp_path directory."""
    from calendar_cache_manager import CalendarCacheManager

    mgr = CalendarCacheManager(cache_dir=str(tmp_path / "cal_cache"))
    return mgr


def _make_meeting(subject="Team standup", organizer="alice@example.com"):
    """Return a SimpleNamespace mimicking a SimpleMeeting object."""
    now = datetime.now()
    return SimpleNamespace(
        subject=subject,
        organizer=organizer,
        start_time=now - timedelta(minutes=30),
        end_time=now,
        location="Room A",
        attendees=[{"name": "Alice"}, {"name": "Bob"}],
    )


# ---------------------------------------------------------------------------
# init / load / save persistence
# ---------------------------------------------------------------------------
class TestInitAndPersistence:
    def test_init_creates_cache_dir(self, tmp_path):
        import os
        from calendar_cache_manager import CalendarCacheManager

        cache_dir = str(tmp_path / "new_cache")
        CalendarCacheManager(cache_dir=cache_dir)
        assert os.path.isdir(cache_dir)

    def test_empty_cache_has_zero_meetings(self, cache):
        stats = cache.get_cache_statistics()
        assert stats["total_meetings_cached"] == 0
        assert stats["total_file_mappings"] == 0

    def test_cache_persists_to_disk_and_reloads(self, tmp_path):
        """Saving a meeting writes to disk; a new instance reads it back."""
        from calendar_cache_manager import CalendarCacheManager

        cache_dir = str(tmp_path / "persist_cache")
        mgr1 = CalendarCacheManager(cache_dir=cache_dir)
        now = datetime.now()
        meeting = _make_meeting()
        mgr1.cache_meeting_for_file("rec.hda", now, meeting)

        # Create a second manager pointing at the same directory
        mgr2 = CalendarCacheManager(cache_dir=cache_dir)
        loaded = mgr2.get_cached_meeting_for_file("rec.hda", now)
        assert loaded is not None
        assert loaded.subject == "Team standup"

    def test_corrupt_json_cache_falls_back_to_empty(self, tmp_path):
        """If the cache JSON is corrupt, manager initializes with empty caches."""
        import os
        from calendar_cache_manager import CalendarCacheManager

        cache_dir = str(tmp_path / "corrupt_cache")
        os.makedirs(cache_dir, exist_ok=True)
        with open(os.path.join(cache_dir, "meetings_cache.json"), "w") as f:
            f.write("{bad json!!!")
        mgr = CalendarCacheManager(cache_dir=cache_dir)
        assert len(mgr._meetings_cache) == 0


# ---------------------------------------------------------------------------
# cache_meeting_for_file / get_cached_meeting_for_file
# ---------------------------------------------------------------------------
class TestCacheMeetingForFile:
    def test_cache_and_retrieve_recent_recording(self, cache):
        now = datetime.now()
        meeting = _make_meeting()
        cached = cache.cache_meeting_for_file("rec1.hda", now, meeting)
        assert cached.subject == "Team standup"

        loaded = cache.get_cached_meeting_for_file("rec1.hda", now)
        assert loaded is not None
        assert loaded.subject == "Team standup"
        assert loaded.organizer == "alice@example.com"

    def test_cached_meeting_has_attendee_count(self, cache):
        now = datetime.now()
        meeting = _make_meeting()
        cached = cache.cache_meeting_for_file("rec2.hda", now, meeting)
        assert cached.attendee_count == 2

    def test_old_recording_gets_longer_expiry(self, cache):
        """Recordings older than 30 days should get a ~365-day expiry."""
        old_date = datetime.now() - timedelta(days=60)
        meeting = _make_meeting()
        cached = cache.cache_meeting_for_file("old_rec.hda", old_date, meeting)
        expires = datetime.fromisoformat(cached.expires_at)
        # Should expire far in the future (at least 300 days from now)
        assert expires > datetime.now() + timedelta(days=300)

    def test_recent_recording_gets_shorter_expiry(self, cache):
        """Recent recordings should get ~24h expiry."""
        now = datetime.now()
        meeting = _make_meeting()
        cached = cache.cache_meeting_for_file("new_rec.hda", now, meeting)
        expires = datetime.fromisoformat(cached.expires_at)
        # Should expire within 2 days, not 300+
        assert expires < datetime.now() + timedelta(days=2)

    def test_uncached_file_returns_none(self, cache):
        now = datetime.now()
        result = cache.get_cached_meeting_for_file("unknown.hda", now)
        assert result is None

    def test_expired_cache_returns_none_and_clears(self, cache):
        """A manually-expired entry should be cleaned up on retrieval."""
        from calendar_cache_manager import CachedMeeting

        now = datetime.now()
        past = (now - timedelta(hours=2)).isoformat()

        # Inject an already-expired entry directly
        key = "EXPIRED_KEY"
        cache._meetings_cache[key] = CachedMeeting(
            subject="Old meeting",
            organizer="bob@example.com",
            start_time=now.isoformat(),
            end_time=now.isoformat(),
            location="",
            attendees=[],
            attendee_count=0,
            display_text="Old meeting",
            cached_at=past,
            expires_at=past,  # already expired
            confidence_score=0.9,
        )
        cache._file_meetings_cache["expired.hda"] = key

        result = cache.get_cached_meeting_for_file("expired.hda", now)
        assert result is None
        # Entry should have been removed
        assert "expired.hda" not in cache._file_meetings_cache


# ---------------------------------------------------------------------------
# cache_no_meeting_for_file
# ---------------------------------------------------------------------------
class TestCacheNoMeetingForFile:
    def test_no_meeting_cached_and_retrieved(self, cache):
        now = datetime.now()
        cache.cache_no_meeting_for_file("no_mtg.hda", now)
        # The cached entry has empty subject — should be returned as a CachedMeeting
        result = cache.get_cached_meeting_for_file("no_mtg.hda", now)
        assert result is not None
        assert result.subject == ""
        assert result.confidence_score == 1.0


# ---------------------------------------------------------------------------
# _generate_meeting_key
# ---------------------------------------------------------------------------
class TestGenerateMeetingKey:
    def test_same_inputs_produce_same_key(self, cache):
        t = datetime(2024, 3, 15, 10, 0)
        k1 = cache._generate_meeting_key("Standup", t, "alice@example.com")
        k2 = cache._generate_meeting_key("Standup", t, "alice@example.com")
        assert k1 == k2

    def test_different_inputs_produce_different_keys(self, cache):
        t = datetime(2024, 3, 15, 10, 0)
        k1 = cache._generate_meeting_key("Standup", t, "alice@example.com")
        k2 = cache._generate_meeting_key("Standup", t, "bob@example.com")
        assert k1 != k2

    def test_key_contains_date(self, cache):
        t = datetime(2024, 3, 15, 10, 0)
        key = cache._generate_meeting_key("Meeting", t, "person@example.com")
        assert "2024-03-15" in key


# ---------------------------------------------------------------------------
# _is_old_recording
# ---------------------------------------------------------------------------
class TestIsOldRecording:
    def test_60_day_old_is_old(self, cache):
        old = datetime.now() - timedelta(days=60)
        assert cache._is_old_recording(old) is True

    def test_yesterday_is_not_old(self, cache):
        recent = datetime.now() - timedelta(days=1)
        assert cache._is_old_recording(recent) is False


# ---------------------------------------------------------------------------
# cleanup_expired_entries
# ---------------------------------------------------------------------------
class TestCleanupExpiredEntries:
    def test_removes_expired_entries(self, cache):
        from calendar_cache_manager import CachedMeeting

        now = datetime.now()
        past = (now - timedelta(hours=1)).isoformat()

        # Add an expired entry
        cache._meetings_cache["EXP1"] = CachedMeeting(
            subject="",
            organizer="",
            start_time=past,
            end_time=past,
            location="",
            attendees=[],
            attendee_count=0,
            display_text="",
            cached_at=past,
            expires_at=past,
            confidence_score=0.0,
        )
        cache._file_meetings_cache["exp_file.hda"] = "EXP1"

        removed = cache.cleanup_expired_entries()
        assert removed == 1
        assert "EXP1" not in cache._meetings_cache
        assert "exp_file.hda" not in cache._file_meetings_cache

    def test_non_expired_entries_are_kept(self, cache):
        now = datetime.now()
        meeting = _make_meeting()
        cache.cache_meeting_for_file("keep.hda", now, meeting)
        removed = cache.cleanup_expired_entries()
        assert removed == 0
        assert "keep.hda" in cache._file_meetings_cache


# ---------------------------------------------------------------------------
# force_refresh_file / force_refresh_all
# ---------------------------------------------------------------------------
class TestForceRefresh:
    def test_force_refresh_file_removes_mapping(self, cache):
        now = datetime.now()
        meeting = _make_meeting()
        cache.cache_meeting_for_file("refresh_me.hda", now, meeting)
        cache.force_refresh_file("refresh_me.hda")
        assert "refresh_me.hda" not in cache._file_meetings_cache

    def test_force_refresh_nonexistent_file_is_noop(self, cache):
        cache.force_refresh_file("ghost.hda")  # should not raise

    def test_force_refresh_all_clears_everything(self, cache):
        now = datetime.now()
        cache.cache_meeting_for_file("a.hda", now, _make_meeting("A"))
        cache.cache_meeting_for_file("b.hda", now, _make_meeting("B"))
        cache.force_refresh_all()
        assert len(cache._meetings_cache) == 0
        assert len(cache._file_meetings_cache) == 0


# ---------------------------------------------------------------------------
# get_cache_statistics
# ---------------------------------------------------------------------------
class TestGetCacheStatistics:
    def test_statistics_keys_present(self, cache):
        stats = cache.get_cache_statistics()
        for key in (
            "total_meetings_cached",
            "total_file_mappings",
            "old_entries",
            "recent_entries",
            "expired_entries",
            "no_meeting_entries",
            "cache_hit_ratio",
        ):
            assert key in stats, f"Missing key: {key}"

    def test_statistics_counts_recent_entry(self, cache):
        now = datetime.now()
        cache.cache_meeting_for_file("stat_test.hda", now, _make_meeting())
        stats = cache.get_cache_statistics()
        assert stats["total_meetings_cached"] == 1
        assert stats["total_file_mappings"] == 1
        assert stats["recent_entries"] == 1

    def test_statistics_counts_no_meeting_entry(self, cache):
        now = datetime.now()
        cache.cache_no_meeting_for_file("no_mtg_stat.hda", now)
        stats = cache.get_cache_statistics()
        assert stats["no_meeting_entries"] >= 1


# ---------------------------------------------------------------------------
# update_display_format_for_existing_cache
# ---------------------------------------------------------------------------
class TestUpdateDisplayFormat:
    def test_strips_organizer_from_display_text(self, cache):
        from calendar_cache_manager import CachedMeeting

        now = datetime.now()
        future = (now + timedelta(days=1)).isoformat()
        now_iso = now.isoformat()

        cache._meetings_cache["TEST_KEY"] = CachedMeeting(
            subject="Standup",
            organizer="Alice",
            start_time=now_iso,
            end_time=now_iso,
            location="",
            attendees=[],
            attendee_count=0,
            display_text="Standup - Alice",  # old format with organizer
            cached_at=now_iso,
            expires_at=future,
            confidence_score=0.9,
        )

        cache.update_display_format_for_existing_cache()
        updated = cache._meetings_cache["TEST_KEY"]
        assert updated.display_text == "Standup"

    def test_no_op_when_no_organizer_in_display(self, cache):
        from calendar_cache_manager import CachedMeeting

        now = datetime.now()
        future = (now + timedelta(days=1)).isoformat()
        now_iso = now.isoformat()

        cache._meetings_cache["CLEAN_KEY"] = CachedMeeting(
            subject="Standup",
            organizer="Alice",
            start_time=now_iso,
            end_time=now_iso,
            location="",
            attendees=[],
            attendee_count=0,
            display_text="Standup",  # already clean
            cached_at=now_iso,
            expires_at=future,
            confidence_score=0.9,
        )

        cache.update_display_format_for_existing_cache()
        # Should remain unchanged
        assert cache._meetings_cache["CLEAN_KEY"].display_text == "Standup"


# ---------------------------------------------------------------------------
# _format_meeting_display_text
# ---------------------------------------------------------------------------
class TestFormatMeetingDisplayText:
    def test_subject_only_when_no_organizer(self, cache):
        meeting = _make_meeting("Weekly review", "")
        meeting.organizer = ""
        text = cache._format_meeting_display_text(meeting, include_organizer=False)
        assert text == "Weekly review"

    def test_truncates_long_subject(self, cache):
        meeting = _make_meeting("A" * 100)
        text = cache._format_meeting_display_text(meeting, include_organizer=False)
        assert len(text) <= 45
        assert text.endswith("...")

    def test_empty_subject_returns_empty_string(self, cache):
        meeting = SimpleNamespace(subject="", organizer="", start_time=datetime.now(),
                                   end_time=datetime.now(), location="", attendees=[])
        text = cache._format_meeting_display_text(meeting)
        assert text == ""

    def test_organizer_appended_when_requested(self, cache):
        meeting = _make_meeting("Standup", "alice@example.com")
        text = cache._format_meeting_display_text(meeting, include_organizer=True)
        # "Alice" (extracted from alice@example.com) should appear
        assert "Alice" in text or "alice" in text.lower()


# ---------------------------------------------------------------------------
# shutdown
# ---------------------------------------------------------------------------
class TestShutdown:
    def test_shutdown_saves_without_error(self, cache):
        """shutdown() should not raise even on empty cache."""
        cache.shutdown()  # Just ensure no exception is raised
