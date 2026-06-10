"""
Gate 4 (Task 5) coverage for audio_metadata_db.AudioMetadataDB.

All tests use a tmp_path SQLite DB — no real files, no USB, no network.
Uses the database_cleanup fixture from conftest.
"""
from datetime import datetime, timedelta

import pytest


@pytest.fixture
def db(tmp_path, database_cleanup):
    """Fresh AudioMetadataDB backed by an in-memory tmp_path file."""
    from audio_metadata_db import AudioMetadataDB

    db_file = str(tmp_path / "test_audio_meta.db")
    instance = AudioMetadataDB(db_file)
    yield instance
    instance.close()


def _now():
    return datetime.now()


def _make_entry(db, filename="test.hda", duration=60.0, size=1024):
    """Helper: create a minimal file entry and return True/False."""
    return db.create_file_entry(
        filename=filename,
        file_path=f"/device/{filename}",
        file_size=size,
        duration_seconds=duration,
        date_created=_now(),
    )


# ---------------------------------------------------------------------------
# Schema / init
# ---------------------------------------------------------------------------
class TestInit:
    def test_creates_db_file(self, tmp_path, database_cleanup):
        from audio_metadata_db import AudioMetadataDB

        db_file = str(tmp_path / "sub" / "audio.db")
        db = AudioMetadataDB(db_file)
        import os

        assert os.path.exists(db_file)
        db.close()

    def test_double_init_is_idempotent(self, tmp_path, database_cleanup):
        """Re-opening the same DB path should not raise."""
        from audio_metadata_db import AudioMetadataDB

        db_file = str(tmp_path / "idempotent.db")
        db1 = AudioMetadataDB(db_file)
        db1.close()
        db2 = AudioMetadataDB(db_file)
        db2.close()


# ---------------------------------------------------------------------------
# create_file_entry
# ---------------------------------------------------------------------------
class TestCreateFileEntry:
    def test_create_returns_true(self, db):
        assert _make_entry(db) is True

    def test_get_after_create_returns_metadata(self, db):
        _make_entry(db, "a.hda")
        meta = db.get_metadata("a.hda")
        assert meta is not None
        assert meta.filename == "a.hda"
        assert meta.file_size == 1024
        assert meta.duration_seconds == 60.0

    def test_processing_status_defaults_not_processed(self, db):
        from audio_metadata_db import ProcessingStatus

        _make_entry(db)
        meta = db.get_metadata("test.hda")
        assert meta.processing_status == ProcessingStatus.NOT_PROCESSED

    def test_display_title_defaults_to_filename_without_extension(self, db):
        _make_entry(db, "my_recording.hda")
        meta = db.get_metadata("my_recording.hda")
        assert meta.display_title == "my_recording"

    def test_upsert_creates_new_or_replaces(self, db):
        _make_entry(db, "dup.hda", size=512)
        _make_entry(db, "dup.hda", size=999)
        meta = db.get_metadata("dup.hda")
        assert meta.file_size == 999


# ---------------------------------------------------------------------------
# get_metadata
# ---------------------------------------------------------------------------
class TestGetMetadata:
    def test_missing_filename_returns_none(self, db):
        assert db.get_metadata("nonexistent.hda") is None

    def test_row_to_metadata_parses_json_lists(self, db):
        """ai_participants / ai_action_items are stored as JSON arrays."""
        from audio_metadata_db import AudioMetadata, ProcessingStatus

        _make_entry(db, "json_test.hda")
        meta = db.get_metadata("json_test.hda")
        # Save with ai data
        meta.ai_participants = ["Alice", "Bob"]
        meta.ai_action_items = ["Do thing 1"]
        meta.ai_topics = ["topic A"]
        meta.ai_key_quotes = ["quote 1"]
        meta.ai_sentiment = "positive"
        db.save_metadata(meta)

        loaded = db.get_metadata("json_test.hda")
        assert loaded.ai_participants == ["Alice", "Bob"]
        assert loaded.ai_action_items == ["Do thing 1"]
        assert loaded.ai_topics == ["topic A"]
        assert loaded.ai_key_quotes == ["quote 1"]
        assert loaded.ai_sentiment == "positive"


# ---------------------------------------------------------------------------
# save_metadata (full upsert)
# ---------------------------------------------------------------------------
class TestSaveMetadata:
    def test_save_returns_true(self, db):
        from audio_metadata_db import AudioMetadata, ProcessingStatus

        _make_entry(db, "save_test.hda")
        meta = db.get_metadata("save_test.hda")
        meta.user_title = "My custom title"
        assert db.save_metadata(meta) is True

    def test_display_title_priority_user_over_ai(self, db):
        from audio_metadata_db import AudioMetadata, ProcessingStatus

        _make_entry(db, "prio.hda")
        meta = db.get_metadata("prio.hda")
        meta.ai_summary = "AI Summary Line"
        meta.user_title = "User Title"
        db.save_metadata(meta)
        loaded = db.get_metadata("prio.hda")
        assert loaded.display_title == "User Title"

    def test_display_title_falls_back_to_ai_summary_first_line(self, db):
        _make_entry(db, "ai_title.hda")
        meta = db.get_metadata("ai_title.hda")
        meta.ai_summary = "First line of summary\nSecond line"
        db.save_metadata(meta)
        loaded = db.get_metadata("ai_title.hda")
        assert loaded.display_title == "First line of summary"

    def test_display_description_uses_user_description_first(self, db):
        _make_entry(db, "desc_test.hda")
        meta = db.get_metadata("desc_test.hda")
        meta.user_description = "My notes"
        meta.ai_summary = "AI summary"
        db.save_metadata(meta)
        loaded = db.get_metadata("desc_test.hda")
        assert loaded.display_description == "My notes"

    def test_display_description_truncates_long_transcription(self, db):
        _make_entry(db, "trunc.hda")
        meta = db.get_metadata("trunc.hda")
        meta.transcription_text = "X" * 300
        db.save_metadata(meta)
        loaded = db.get_metadata("trunc.hda")
        assert len(loaded.display_description) <= 203  # 200 chars + "..."
        assert loaded.display_description.endswith("...")

    def test_display_description_short_transcription_no_ellipsis(self, db):
        _make_entry(db, "short.hda")
        meta = db.get_metadata("short.hda")
        meta.transcription_text = "Short text"
        db.save_metadata(meta)
        loaded = db.get_metadata("short.hda")
        assert loaded.display_description == "Short text"

    def test_user_tags_roundtrip(self, db):
        _make_entry(db, "tags.hda")
        meta = db.get_metadata("tags.hda")
        meta.user_tags = ["tag1", "tag2", "tag3"]
        meta.user_participants = ["Alice"]
        meta.user_action_items = ["action 1"]
        db.save_metadata(meta)
        loaded = db.get_metadata("tags.hda")
        assert loaded.user_tags == ["tag1", "tag2", "tag3"]
        assert loaded.user_participants == ["Alice"]
        assert loaded.user_action_items == ["action 1"]


# ---------------------------------------------------------------------------
# update_processing_status
# ---------------------------------------------------------------------------
class TestUpdateProcessingStatus:
    def test_transcribing_sets_started_at(self, db):
        from audio_metadata_db import ProcessingStatus

        _make_entry(db)
        assert db.update_processing_status("test.hda", ProcessingStatus.TRANSCRIBING) is True
        meta = db.get_metadata("test.hda")
        assert meta.processing_status == ProcessingStatus.TRANSCRIBING
        assert meta.processing_started_at is not None

    def test_completed_sets_completed_at(self, db):
        from audio_metadata_db import ProcessingStatus

        _make_entry(db)
        assert db.update_processing_status("test.hda", ProcessingStatus.COMPLETED) is True
        meta = db.get_metadata("test.hda")
        assert meta.processing_status == ProcessingStatus.COMPLETED
        assert meta.processing_completed_at is not None

    def test_error_status_stores_error_message(self, db):
        from audio_metadata_db import ProcessingStatus

        _make_entry(db)
        db.update_processing_status("test.hda", ProcessingStatus.ERROR, error_message="Failed: timeout")
        meta = db.get_metadata("test.hda")
        assert meta.processing_status == ProcessingStatus.ERROR
        assert meta.processing_error == "Failed: timeout"

    def test_transcribed_status_update(self, db):
        from audio_metadata_db import ProcessingStatus

        _make_entry(db)
        db.update_processing_status("test.hda", ProcessingStatus.TRANSCRIBED)
        meta = db.get_metadata("test.hda")
        assert meta.processing_status == ProcessingStatus.TRANSCRIBED


# ---------------------------------------------------------------------------
# save_transcription
# ---------------------------------------------------------------------------
class TestSaveTranscription:
    def test_save_transcription_updates_status(self, db):
        from audio_metadata_db import ProcessingStatus

        _make_entry(db)
        result = db.save_transcription("test.hda", "Hello world transcription", confidence=0.95, language="en")
        assert result is True
        meta = db.get_metadata("test.hda")
        assert meta.transcription_text == "Hello world transcription"
        assert meta.transcription_confidence == 0.95
        assert meta.transcription_language == "en"
        assert meta.processing_status == ProcessingStatus.TRANSCRIBED


# ---------------------------------------------------------------------------
# save_ai_analysis
# ---------------------------------------------------------------------------
class TestSaveAIAnalysis:
    def test_save_ai_analysis_updates_fields(self, db):
        from audio_metadata_db import ProcessingStatus

        _make_entry(db, "ai_test.hda")
        result = db.save_ai_analysis(
            "ai_test.hda",
            summary="This meeting covered Q3 goals",
            participants=["Alice", "Bob"],
            action_items=["Send report"],
            topics=["Q3", "Goals"],
            sentiment="positive",
            key_quotes=["Let's do this"],
        )
        assert result is True
        meta = db.get_metadata("ai_test.hda")
        assert meta.ai_summary == "This meeting covered Q3 goals"
        assert meta.ai_participants == ["Alice", "Bob"]
        assert meta.ai_action_items == ["Send report"]
        assert meta.ai_topics == ["Q3", "Goals"]
        assert meta.ai_sentiment == "positive"
        assert meta.ai_key_quotes == ["Let's do this"]
        assert meta.processing_status == ProcessingStatus.AI_ANALYZED

    def test_save_ai_analysis_missing_entry_returns_false(self, db):
        result = db.save_ai_analysis("ghost.hda", summary="No entry")
        assert result is False


# ---------------------------------------------------------------------------
# update_user_fields
# ---------------------------------------------------------------------------
class TestUpdateUserFields:
    def test_update_user_title(self, db):
        _make_entry(db, "user_fields.hda")
        result = db.update_user_fields("user_fields.hda", user_title="My Title")
        assert result is True
        meta = db.get_metadata("user_fields.hda")
        assert meta.user_title == "My Title"

    def test_update_user_notes_and_tags(self, db):
        _make_entry(db, "notes.hda")
        db.update_user_fields("notes.hda", user_notes="Some notes", user_tags=["a", "b"])
        meta = db.get_metadata("notes.hda")
        assert meta.user_notes == "Some notes"
        assert meta.user_tags == ["a", "b"]

    def test_update_missing_entry_returns_false(self, db):
        result = db.update_user_fields("ghost.hda", user_title="T")
        assert result is False


# ---------------------------------------------------------------------------
# get_files_by_status
# ---------------------------------------------------------------------------
class TestGetFilesByStatus:
    def test_returns_files_matching_status(self, db):
        from audio_metadata_db import ProcessingStatus

        _make_entry(db, "a.hda")
        _make_entry(db, "b.hda")
        db.update_processing_status("a.hda", ProcessingStatus.TRANSCRIBING)

        transcribing = db.get_files_by_status(ProcessingStatus.TRANSCRIBING)
        filenames = [m.filename for m in transcribing]
        assert "a.hda" in filenames
        assert "b.hda" not in filenames

    def test_empty_result_for_unused_status(self, db):
        from audio_metadata_db import ProcessingStatus

        result = db.get_files_by_status(ProcessingStatus.AI_ANALYZED)
        assert result == []


# ---------------------------------------------------------------------------
# get_all_metadata
# ---------------------------------------------------------------------------
class TestGetAllMetadata:
    def test_returns_all_entries(self, db):
        _make_entry(db, "x.hda")
        _make_entry(db, "y.hda")
        all_meta = db.get_all_metadata()
        filenames = [m.filename for m in all_meta]
        assert "x.hda" in filenames
        assert "y.hda" in filenames


# ---------------------------------------------------------------------------
# search_metadata
# ---------------------------------------------------------------------------
class TestSearchMetadata:
    def test_search_finds_transcription_text(self, db):
        _make_entry(db, "search_test.hda")
        db.save_transcription("search_test.hda", "The quick brown fox jumps", language="en")
        results = db.search_metadata("quick brown")
        assert any(m.filename == "search_test.hda" for m in results)

    def test_search_no_match_returns_empty(self, db):
        _make_entry(db, "no_match.hda")
        results = db.search_metadata("xyzzy_not_found_anywhere")
        assert results == []

    def test_search_finds_user_title(self, db):
        _make_entry(db, "u_search.hda")
        meta = db.get_metadata("u_search.hda")
        meta.user_title = "Important meeting notes"
        db.save_metadata(meta)
        results = db.search_metadata("Important meeting")
        assert any(m.filename == "u_search.hda" for m in results)


# ---------------------------------------------------------------------------
# delete_metadata
# ---------------------------------------------------------------------------
class TestDeleteMetadata:
    def test_delete_existing_returns_true(self, db):
        _make_entry(db)
        assert db.delete_metadata("test.hda") is True
        assert db.get_metadata("test.hda") is None

    def test_delete_nonexistent_returns_false(self, db):
        assert db.delete_metadata("ghost.hda") is False

    def test_delete_removes_processing_log_too(self, db):
        from audio_metadata_db import ProcessingStatus

        _make_entry(db)
        db.update_processing_status("test.hda", ProcessingStatus.TRANSCRIBING)
        # Should not raise foreign key violation
        assert db.delete_metadata("test.hda") is True


# ---------------------------------------------------------------------------
# cleanup_orphaned_entries
# ---------------------------------------------------------------------------
class TestCleanupOrphanedEntries:
    def test_removes_entries_not_in_existing_list(self, db):
        _make_entry(db, "keep.hda")
        _make_entry(db, "orphan.hda")
        removed = db.cleanup_orphaned_entries(["keep.hda"])
        assert removed == 1
        assert db.get_metadata("orphan.hda") is None
        assert db.get_metadata("keep.hda") is not None

    def test_no_orphans_returns_zero(self, db):
        _make_entry(db, "present.hda")
        removed = db.cleanup_orphaned_entries(["present.hda"])
        assert removed == 0


# ---------------------------------------------------------------------------
# get_processing_statistics
# ---------------------------------------------------------------------------
class TestGetProcessingStatistics:
    def test_counts_by_status(self, db):
        from audio_metadata_db import ProcessingStatus

        _make_entry(db, "s1.hda")
        _make_entry(db, "s2.hda")
        db.update_processing_status("s2.hda", ProcessingStatus.TRANSCRIBING)
        stats = db.get_processing_statistics()
        assert stats.get("not_processed", 0) >= 1
        assert stats.get("transcribing", 0) >= 1


# ---------------------------------------------------------------------------
# get_status_display_text
# ---------------------------------------------------------------------------
class TestGetStatusDisplayText:
    def test_not_processed_is_blank(self, db):
        from audio_metadata_db import AudioMetadata, ProcessingStatus

        _make_entry(db)
        meta = db.get_metadata("test.hda")
        text = db.get_status_display_text(meta)
        assert text == ""

    def test_transcribing_returns_string(self, db):
        from audio_metadata_db import ProcessingStatus

        _make_entry(db)
        db.update_processing_status("test.hda", ProcessingStatus.TRANSCRIBING)
        meta = db.get_metadata("test.hda")
        text = db.get_status_display_text(meta)
        assert "Transcribing" in text

    def test_error_returns_error_string(self, db):
        from audio_metadata_db import ProcessingStatus

        _make_entry(db)
        db.update_processing_status("test.hda", ProcessingStatus.ERROR)
        meta = db.get_metadata("test.hda")
        text = db.get_status_display_text(meta)
        assert "Error" in text

    def test_ai_analyzed_returns_display_title(self, db):
        from audio_metadata_db import ProcessingStatus

        _make_entry(db, "analyzed.hda")
        db.save_ai_analysis(
            "analyzed.hda",
            summary="Key meeting summary",
        )
        meta = db.get_metadata("analyzed.hda")
        text = db.get_status_display_text(meta)
        # AI-analyzed status surfaces in the display text.
        assert "Key meeting summary" in text
