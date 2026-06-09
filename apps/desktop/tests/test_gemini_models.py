"""
Gate 4 (Task 5) coverage for gemini_models.

Pure helpers: normalize_model_name, is_valid_model_name,
validate_model_for_transcription, list_available_models,
get_model_info, get_recommended_models. No network calls.
"""
import pytest


@pytest.fixture(autouse=True)
def import_module():
    """Ensure the module is importable (no side-effects, just data)."""
    import gemini_models  # noqa: F401


# ---------------------------------------------------------------------------
# is_valid_model_name
# ---------------------------------------------------------------------------
class TestIsValidModelName:
    def test_known_stable_model_is_valid(self):
        from gemini_models import is_valid_model_name

        assert is_valid_model_name("gemini-2.5-pro") is True

    def test_known_flash_model_is_valid(self):
        from gemini_models import is_valid_model_name

        assert is_valid_model_name("gemini-2.5-flash") is True

    def test_models_prefix_variant_is_valid(self):
        from gemini_models import is_valid_model_name

        assert is_valid_model_name("models/gemini-2.5-pro") is True

    def test_any_gemini_prefixed_name_is_valid(self):
        from gemini_models import is_valid_model_name

        assert is_valid_model_name("gemini-future-unknown") is True

    def test_empty_string_is_invalid(self):
        from gemini_models import is_valid_model_name

        assert is_valid_model_name("") is False

    def test_non_gemini_name_is_invalid(self):
        from gemini_models import is_valid_model_name

        assert is_valid_model_name("gpt-4") is False
        assert is_valid_model_name("claude-3") is False

    def test_none_like_empty_is_invalid(self):
        from gemini_models import is_valid_model_name

        assert is_valid_model_name("") is False


# ---------------------------------------------------------------------------
# normalize_model_name
# ---------------------------------------------------------------------------
class TestNormalizeModelName:
    def test_legacy_1_5_flash_maps_to_current(self):
        from gemini_models import normalize_model_name

        result = normalize_model_name("gemini-1.5-flash")
        assert result != "gemini-1.5-flash"
        assert "gemini" in result

    def test_legacy_1_5_pro_maps_to_current(self):
        from gemini_models import normalize_model_name

        result = normalize_model_name("gemini-1.5-pro")
        assert result != "gemini-1.5-pro"
        assert "gemini" in result

    def test_current_name_passthrough_unchanged(self):
        from gemini_models import normalize_model_name

        # A current name with no legacy mapping should pass through
        assert normalize_model_name("gemini-2.5-pro") == "gemini-2.5-pro"

    def test_unknown_name_passthrough_unchanged(self):
        from gemini_models import normalize_model_name

        assert normalize_model_name("my-custom-model") == "my-custom-model"


# ---------------------------------------------------------------------------
# validate_model_for_transcription
# ---------------------------------------------------------------------------
class TestValidateModelForTranscription:
    def test_audio_supporting_model_is_valid(self):
        from gemini_models import validate_model_for_transcription

        ok, msg = validate_model_for_transcription("gemini-2.5-pro")
        assert ok is True
        assert "gemini-2.5-pro" in msg

    def test_flash_lite_does_not_support_audio(self):
        from gemini_models import validate_model_for_transcription

        ok, msg = validate_model_for_transcription("gemini-2.5-flash-lite")
        assert ok is False
        assert "audio" in msg.lower() or "not support" in msg.lower()

    def test_unknown_model_is_invalid(self):
        from gemini_models import validate_model_for_transcription

        ok, msg = validate_model_for_transcription("gpt-4")
        assert ok is False
        assert "gpt-4" in msg or "Unknown" in msg

    def test_flash_model_supports_audio(self):
        from gemini_models import validate_model_for_transcription

        ok, msg = validate_model_for_transcription("gemini-2.5-flash")
        assert ok is True


# ---------------------------------------------------------------------------
# list_available_models
# ---------------------------------------------------------------------------
class TestListAvailableModels:
    def test_returns_sorted_list(self):
        from gemini_models import list_available_models

        models = list_available_models()
        assert isinstance(models, list)
        assert len(models) > 0
        assert models == sorted(models)

    def test_filter_audio_support_excludes_non_audio(self):
        from gemini_models import list_available_models

        audio_models = list_available_models(filter_audio_support=True)
        non_audio_models = list_available_models(filter_audio_support=False)
        # Audio-only list should be strictly smaller
        assert len(audio_models) <= len(non_audio_models)
        # flash-lite does not support audio — must not appear in audio-only list
        assert "gemini-2.5-flash-lite" not in audio_models

    def test_filter_by_status_stable(self):
        from gemini_models import list_available_models

        stable = list_available_models(filter_status="stable")
        assert len(stable) > 0
        for name in stable:
            from gemini_models import KNOWN_GEMINI_MODELS

            assert KNOWN_GEMINI_MODELS[name]["status"] == "stable"

    def test_filter_by_status_experimental_excludes_stable(self):
        from gemini_models import list_available_models

        exp = list_available_models(filter_status="experimental")
        stable = list_available_models(filter_status="stable")
        # No overlap between stable and experimental
        assert not set(exp) & set(stable)

    def test_no_filter_includes_all_known_models(self):
        from gemini_models import KNOWN_GEMINI_MODELS, list_available_models

        all_models = list_available_models()
        for name in KNOWN_GEMINI_MODELS:
            assert name in all_models


# ---------------------------------------------------------------------------
# get_model_info
# ---------------------------------------------------------------------------
class TestGetModelInfo:
    def test_known_model_returns_dict_with_name(self):
        from gemini_models import get_model_info

        info = get_model_info("gemini-2.5-pro")
        assert info is not None
        assert info["name"] == "gemini-2.5-pro"
        assert "description" in info
        assert "status" in info
        assert "supports_audio" in info

    def test_models_prefix_variant_returns_info(self):
        from gemini_models import get_model_info

        info = get_model_info("models/gemini-2.5-pro")
        assert info is not None
        assert info["name"] == "models/gemini-2.5-pro"

    def test_unknown_model_returns_none(self):
        from gemini_models import get_model_info

        assert get_model_info("completely-unknown-model") is None


# ---------------------------------------------------------------------------
# get_recommended_models
# ---------------------------------------------------------------------------
class TestGetRecommendedModels:
    def test_returns_dict_with_known_use_cases(self):
        from gemini_models import get_recommended_models

        rec = get_recommended_models()
        assert isinstance(rec, dict)
        assert "transcription" in rec
        assert "analysis" in rec

    def test_transcription_model_supports_audio(self):
        from gemini_models import get_recommended_models, validate_model_for_transcription

        rec = get_recommended_models()
        ok, _ = validate_model_for_transcription(rec["transcription"])
        assert ok is True


# ---------------------------------------------------------------------------
# fetch_models_from_api — error paths (no network needed)
# ---------------------------------------------------------------------------
class TestFetchModelsFromApi:
    def test_import_error_returns_none(self, monkeypatch):
        """When google.genai is not installed, function returns None."""
        import sys
        import types

        from gemini_models import fetch_models_from_api

        # Remove google package from sys.modules so the import inside the
        # function raises ImportError
        saved = {k: v for k, v in sys.modules.items() if k == "google" or k.startswith("google.")}
        for k in saved:
            del sys.modules[k]
        # Insert a sentinel that raises on attribute access for 'genai'
        broken = types.ModuleType("google")

        def _bad_getattr(name):
            raise ImportError("google-genai not installed")

        broken.__getattr__ = _bad_getattr
        sys.modules["google"] = broken
        try:
            result = fetch_models_from_api("fake-key")
            assert result is None
        finally:
            # Restore original modules
            for k in list(sys.modules.keys()):
                if k == "google" or k.startswith("google."):
                    del sys.modules[k]
            sys.modules.update(saved)

    def test_generic_exception_returns_none(self, monkeypatch):
        """Any non-ImportError from the API call returns None."""
        import sys
        import types
        from unittest.mock import MagicMock

        from gemini_models import fetch_models_from_api

        # Create a mock google.genai that raises RuntimeError when called
        genai_mod = MagicMock()
        genai_mod.Client.side_effect = RuntimeError("API failure")

        google_mod = types.ModuleType("google")
        google_mod.genai = genai_mod

        saved = {k: v for k, v in sys.modules.items() if k == "google" or k.startswith("google.")}
        sys.modules["google"] = google_mod
        sys.modules["google.genai"] = genai_mod
        try:
            result = fetch_models_from_api("fake-key")
            assert result is None
        finally:
            for k in list(sys.modules.keys()):
                if k == "google" or k.startswith("google."):
                    del sys.modules[k]
            sys.modules.update(saved)
