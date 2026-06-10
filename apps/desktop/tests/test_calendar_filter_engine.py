"""
Gate 4 (Task 5) coverage for calendar_filter_engine.CalendarFilterEngine.

Pure in-memory event dicts — no USB, no Outlook, no network.
"""
from datetime import datetime, timedelta

import pytest


@pytest.fixture
def engine():
    from calendar_filter_engine import CalendarFilterEngine

    return CalendarFilterEngine()


@pytest.fixture
def sample_events():
    """Return a small list of file/event dicts for filter testing."""
    now = datetime.now()
    return [
        {
            "name": "rec1.hda",
            "meeting_subject": "Weekly team standup",
            "meeting_organizer": "alice@example.com",
            "meeting_attendees_display": "alice, bob, carol",
            "meeting_type": "teams",
            "meeting_start_time": now - timedelta(hours=2),
            "has_meeting": True,
        },
        {
            "name": "rec2.hda",
            "meeting_subject": "Product roadmap review",
            "meeting_organizer": "bob@example.com",
            "meeting_attendees_display": "bob, dave",
            "meeting_type": "zoom",
            "meeting_start_time": now - timedelta(hours=10),
            "has_meeting": True,
        },
        {
            "name": "rec3.hda",
            "meeting_subject": "",
            "meeting_organizer": "",
            "meeting_attendees_display": "",
            "meeting_type": "",
            "meeting_start_time": now - timedelta(days=5),
            "has_meeting": False,
        },
    ]


# ---------------------------------------------------------------------------
# apply_filters — dispatch
# ---------------------------------------------------------------------------
class TestApplyFilters:
    def test_empty_filters_returns_all(self, engine, sample_events):
        result = engine.apply_filters(sample_events, {})
        assert result == sample_events

    def test_none_filters_returns_all(self, engine, sample_events):
        result = engine.apply_filters(sample_events, {})
        assert len(result) == len(sample_events)

    def test_subject_filter_dispatched(self, engine, sample_events):
        result = engine.apply_filters(sample_events, {"subject": "standup"})
        names = [e["name"] for e in result]
        assert "rec1.hda" in names
        assert "rec2.hda" not in names

    def test_participant_filter_dispatched(self, engine, sample_events):
        result = engine.apply_filters(sample_events, {"participant": "alice"})
        assert any(e["name"] == "rec1.hda" for e in result)
        assert all(e["name"] != "rec2.hda" for e in result)

    def test_date_range_filter_dispatched(self, engine, sample_events):
        now = datetime.now()
        result = engine.apply_filters(
            sample_events,
            {"date_range": {"start": now - timedelta(hours=5), "end": now}},
        )
        names = [e["name"] for e in result]
        assert "rec1.hda" in names   # 2h ago — in range
        assert "rec3.hda" not in names  # 5 days ago — out of range

    def test_meeting_type_filter_dispatched(self, engine, sample_events):
        result = engine.apply_filters(sample_events, {"meeting_types": ["teams"]})
        assert len(result) == 1
        assert result[0]["name"] == "rec1.hda"

    def test_apply_filters_returns_original_on_error(self, engine):
        """If a filter crashes, original data is returned unchanged (src:66-68)."""
        bad_events = [{"name": "x.hda", "meeting_subject": "standup"}]
        # A non-string subject makes filter_by_subject raise on .lower() (outside
        # its per-file try), which propagates to apply_filters' except branch.
        result = engine.apply_filters(bad_events, {"subject": 123})
        # The except branch returns the original list unchanged, not [].
        assert result == bad_events


# ---------------------------------------------------------------------------
# filter_by_subject
# ---------------------------------------------------------------------------
class TestFilterBySubject:
    def test_exact_substring_match(self, engine, sample_events):
        result = engine.filter_by_subject(sample_events, "standup")
        assert len(result) == 1
        assert result[0]["name"] == "rec1.hda"

    def test_case_insensitive_match(self, engine, sample_events):
        result = engine.filter_by_subject(sample_events, "STANDUP")
        assert len(result) == 1

    def test_empty_search_term_returns_all(self, engine, sample_events):
        result = engine.filter_by_subject(sample_events, "")
        assert result == sample_events

    def test_no_match_returns_empty(self, engine, sample_events):
        result = engine.filter_by_subject(sample_events, "nonexistent-xyz-999")
        assert result == []

    def test_fuzzy_match_is_applied_when_enabled(self, engine):
        """'stadup' (typo) should fuzzy-match 'standup'."""
        event = [{"name": "r.hda", "meeting_subject": "standup"}]
        result = engine.filter_by_subject(event, "stadup", fuzzy=True)
        # SequenceMatcher("stadup", "standup").ratio() == 0.923 ≥ 0.6 threshold,
        # so the match is deterministic — the typo event must be included.
        assert len(result) == 1
        assert result[0]["name"] == "r.hda"

    def test_no_meeting_subject_skipped(self, engine):
        """Events without meeting_subject are excluded from results."""
        events = [{"name": "a.hda", "meeting_subject": ""}]
        result = engine.filter_by_subject(events, "anything")
        assert result == []

    def test_fuzzy_disabled_no_extra_matches(self, engine):
        events = [
            {"name": "r1.hda", "meeting_subject": "standup"},
            {"name": "r2.hda", "meeting_subject": "roadmap"},
        ]
        result = engine.filter_by_subject(events, "stadup", fuzzy=False)
        # Without fuzzy, a misspelled term should not match
        assert result == []


# ---------------------------------------------------------------------------
# filter_by_participant
# ---------------------------------------------------------------------------
class TestFilterByParticipant:
    def test_matches_organizer_email(self, engine, sample_events):
        result = engine.filter_by_participant(sample_events, "alice")
        assert any(e["name"] == "rec1.hda" for e in result)

    def test_matches_attendees_display(self, engine, sample_events):
        result = engine.filter_by_participant(sample_events, "carol")
        assert any(e["name"] == "rec1.hda" for e in result)

    def test_empty_participant_returns_all(self, engine, sample_events):
        result = engine.filter_by_participant(sample_events, "")
        assert result == sample_events

    def test_unknown_participant_returns_empty(self, engine, sample_events):
        result = engine.filter_by_participant(sample_events, "zzz-nobody")
        assert result == []


# ---------------------------------------------------------------------------
# filter_by_date_range
# ---------------------------------------------------------------------------
class TestFilterByDateRange:
    def test_in_range_event_included(self, engine, sample_events):
        now = datetime.now()
        result = engine.filter_by_date_range(
            sample_events,
            now - timedelta(hours=3),
            now,
        )
        names = [e["name"] for e in result]
        assert "rec1.hda" in names

    def test_out_of_range_event_excluded(self, engine, sample_events):
        now = datetime.now()
        result = engine.filter_by_date_range(
            sample_events,
            now - timedelta(hours=3),
            now,
        )
        # rec3 is 5 days ago — out of range
        assert all(e["name"] != "rec3.hda" for e in result)

    def test_none_start_returns_all(self, engine, sample_events):
        result = engine.filter_by_date_range(sample_events, None, None)
        assert result == sample_events

    def test_fallback_to_file_time(self, engine):
        """Uses 'time' key when 'meeting_start_time' is absent."""
        now = datetime.now()
        events = [{"name": "f.hda", "time": now - timedelta(hours=1)}]
        result = engine.filter_by_date_range(
            events,
            now - timedelta(hours=2),
            now,
        )
        assert len(result) == 1


# ---------------------------------------------------------------------------
# filter_by_meeting_type
# ---------------------------------------------------------------------------
class TestFilterByMeetingType:
    def test_filter_teams_only(self, engine, sample_events):
        result = engine.filter_by_meeting_type(sample_events, ["teams"])
        assert len(result) == 1
        assert result[0]["name"] == "rec1.hda"

    def test_filter_multiple_types(self, engine, sample_events):
        result = engine.filter_by_meeting_type(sample_events, ["teams", "zoom"])
        assert len(result) == 2

    def test_empty_types_returns_all(self, engine, sample_events):
        result = engine.filter_by_meeting_type(sample_events, [])
        assert result == sample_events

    def test_case_insensitive_type_match(self, engine):
        events = [{"name": "r.hda", "meeting_type": "Teams"}]
        result = engine.filter_by_meeting_type(events, ["teams"])
        assert len(result) == 1


# ---------------------------------------------------------------------------
# filter_by_has_meeting
# ---------------------------------------------------------------------------
class TestFilterByHasMeeting:
    def test_has_meeting_true_includes_only_meetings(self, engine, sample_events):
        result = engine.filter_by_has_meeting(sample_events, True)
        assert all(e["has_meeting"] for e in result)
        assert len(result) == 2

    def test_has_meeting_false_includes_only_no_meetings(self, engine, sample_events):
        result = engine.filter_by_has_meeting(sample_events, False)
        assert all(not e["has_meeting"] for e in result)
        assert len(result) == 1


# ---------------------------------------------------------------------------
# get_filter_suggestions
# ---------------------------------------------------------------------------
class TestGetFilterSuggestions:
    def test_subject_suggestions_extracted(self, engine, sample_events):
        suggestions = engine.get_filter_suggestions(sample_events, "subject")
        assert isinstance(suggestions, list)
        # Words from "Weekly team standup" and "Product roadmap review" should appear
        assert any(s in suggestions for s in ["weekly", "team", "standup", "product", "roadmap"])

    def test_organizer_suggestions_extracted(self, engine, sample_events):
        suggestions = engine.get_filter_suggestions(sample_events, "organizer")
        assert isinstance(suggestions, list)
        assert len(suggestions) > 0

    def test_type_suggestions_extracted(self, engine, sample_events):
        suggestions = engine.get_filter_suggestions(sample_events, "type")
        assert "teams" in suggestions or "zoom" in suggestions

    def test_unknown_filter_type_returns_empty(self, engine, sample_events):
        suggestions = engine.get_filter_suggestions(sample_events, "unknown_type")
        assert suggestions == []


# ---------------------------------------------------------------------------
# get_statistics
# ---------------------------------------------------------------------------
class TestGetStatistics:
    def test_statistics_counts_are_correct(self, engine, sample_events):
        stats = engine.get_statistics(sample_events)
        assert stats["total_files"] == 3
        assert stats["files_with_meetings"] == 2
        assert stats["files_without_meetings"] == 1

    def test_statistics_meeting_types_counted(self, engine, sample_events):
        stats = engine.get_statistics(sample_events)
        assert "meeting_types" in stats
        assert stats["meeting_types"].get("teams", 0) == 1
        assert stats["meeting_types"].get("zoom", 0) == 1

    def test_statistics_unique_organizers(self, engine, sample_events):
        stats = engine.get_statistics(sample_events)
        assert stats["unique_organizers"] == 2

    def test_empty_events_list(self, engine):
        stats = engine.get_statistics([])
        assert stats["total_files"] == 0
        assert stats["files_with_meetings"] == 0


# ---------------------------------------------------------------------------
# _is_fuzzy_match (internal)
# ---------------------------------------------------------------------------
class TestIsFuzzyMatch:
    def test_identical_strings_match(self, engine):
        assert engine._is_fuzzy_match("hello", "hello") is True

    def test_very_different_strings_dont_match(self, engine):
        assert engine._is_fuzzy_match("abc", "xyz987654") is False

    def test_threshold_respected(self, engine):
        # "standup" vs "stadup" — high similarity
        score_ok = engine._is_fuzzy_match("standup", "standup")
        assert score_ok is True
