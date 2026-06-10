"""
Gate 4 (Task 5) coverage for oauth2_token_manager.OAuth2TokenManager.

Pure local Fernet+JSON, no network. Uses tmp_path for isolation.
"""
import json
import os
from datetime import datetime, timedelta

import pytest

pytest.importorskip("cryptography")


@pytest.fixture
def manager(tmp_path):
    from oauth2_token_manager import OAuth2TokenManager

    return OAuth2TokenManager(config_dir=str(tmp_path / "oauth_cfg"))


# ---------------------------------------------------------------------------
# save / load round-trip
# ---------------------------------------------------------------------------
class TestSaveLoadRoundTrip:
    def test_save_then_load_decrypts_access_and_refresh_tokens(self, manager):
        tokens = {
            "access_token": "AT-secret-123",
            "refresh_token": "RT-secret-456",
            "expires_in": 3600,
            "token_type": "Bearer",
        }
        assert manager.save_tokens("microsoft", tokens) is True
        loaded = manager.load_tokens("microsoft")
        assert loaded is not None
        assert loaded["access_token"] == "AT-secret-123"
        assert loaded["refresh_token"] == "RT-secret-456"
        assert loaded["token_type"] == "Bearer"
        assert "expires_at" in loaded
        assert "saved_at" in loaded

    def test_load_unknown_provider_returns_none(self, manager):
        assert manager.load_tokens("google") is None

    def test_tokens_are_encrypted_at_rest(self, manager, tmp_path):
        """Plaintext access token must not appear verbatim in the JSON file."""
        manager.save_tokens("microsoft", {"access_token": "AT-secret-123", "expires_in": 60})
        raw = (tmp_path / "oauth_cfg" / "oauth2_tokens.json").read_text(encoding="utf-8")
        assert "AT-secret-123" not in raw

    def test_save_token_without_expires_in(self, manager):
        """Token without expires_in should still save and load access_token."""
        tokens = {"access_token": "AT-no-expiry", "token_type": "Bearer"}
        assert manager.save_tokens("slack", tokens) is True
        loaded = manager.load_tokens("slack")
        assert loaded is not None
        assert loaded["access_token"] == "AT-no-expiry"
        assert "expires_at" not in loaded

    def test_multiple_providers_stored_independently(self, manager):
        manager.save_tokens("microsoft", {"access_token": "MS-token", "expires_in": 3600})
        manager.save_tokens("google", {"access_token": "G-token", "expires_in": 3600})
        ms = manager.load_tokens("microsoft")
        goog = manager.load_tokens("google")
        assert ms["access_token"] == "MS-token"
        assert goog["access_token"] == "G-token"


# ---------------------------------------------------------------------------
# is_token_valid
# ---------------------------------------------------------------------------
class TestIsTokenValid:
    def test_freshly_saved_token_is_valid(self, manager):
        """Token expiring far in the future should be valid."""
        manager.save_tokens("microsoft", {"access_token": "T", "expires_in": 7200})
        assert manager.is_token_valid("microsoft") is True

    def test_expired_token_is_invalid(self, manager):
        """Manually inject an already-expired expires_at."""
        past_iso = (datetime.now() - timedelta(hours=1)).isoformat()
        all_tokens = {"microsoft": {"access_token": manager._encrypt("T"), "expires_at": past_iso}}
        with open(manager.tokens_file, "w", encoding="utf-8") as f:
            json.dump(all_tokens, f)
        assert manager.is_token_valid("microsoft") is False

    def test_token_without_expires_at_is_invalid(self, manager):
        """Token stored without an expires_at is treated as invalid."""
        # save_tokens with no expires_in stamps no expires_at, so the token
        # has no validity window and is treated as invalid.
        manager.save_tokens("microsoft", {"access_token": "T"})
        assert manager.is_token_valid("microsoft") is False

    def test_missing_provider_is_invalid(self, manager):
        assert manager.is_token_valid("nonexistent") is False


# ---------------------------------------------------------------------------
# get_access_token
# ---------------------------------------------------------------------------
class TestGetAccessToken:
    def test_returns_access_token_when_valid(self, manager):
        manager.save_tokens("microsoft", {"access_token": "valid-AT", "expires_in": 7200})
        token = manager.get_access_token("microsoft")
        assert token == "valid-AT"

    def test_returns_none_when_no_refresh_token_and_expired(self, manager):
        """Expired token with no refresh_token → get_access_token returns None."""
        past_iso = (datetime.now() - timedelta(hours=1)).isoformat()
        raw_tokens = {"microsoft": {"access_token": manager._encrypt("stale-AT"), "expires_at": past_iso}}
        with open(manager.tokens_file, "w", encoding="utf-8") as f:
            json.dump(raw_tokens, f)
        # refresh_token() will fail (no refresh_token key) → returns None
        token = manager.get_access_token("microsoft")
        assert token is None


# ---------------------------------------------------------------------------
# delete_tokens / get_all_providers
# ---------------------------------------------------------------------------
class TestDeleteTokens:
    def test_delete_existing_provider_returns_true(self, manager):
        manager.save_tokens("microsoft", {"access_token": "T", "expires_in": 3600})
        assert manager.delete_tokens("microsoft") is True
        assert manager.load_tokens("microsoft") is None

    def test_delete_nonexistent_provider_returns_false(self, manager):
        assert manager.delete_tokens("nonexistent") is False

    def test_delete_removes_only_target_provider(self, manager):
        manager.save_tokens("microsoft", {"access_token": "MS", "expires_in": 3600})
        manager.save_tokens("google", {"access_token": "G", "expires_in": 3600})
        manager.delete_tokens("microsoft")
        assert manager.load_tokens("microsoft") is None
        assert manager.load_tokens("google") is not None

    def test_get_all_providers_reflects_saves_and_deletes(self, manager):
        manager.save_tokens("microsoft", {"access_token": "MS", "expires_in": 3600})
        manager.save_tokens("google", {"access_token": "G", "expires_in": 3600})
        providers = manager.get_all_providers()
        assert "microsoft" in providers
        assert "google" in providers
        manager.delete_tokens("microsoft")
        providers = manager.get_all_providers()
        assert "microsoft" not in providers
        assert "google" in providers


# ---------------------------------------------------------------------------
# get_token_info
# ---------------------------------------------------------------------------
class TestGetTokenInfo:
    def test_token_info_contains_expected_keys(self, manager):
        manager.save_tokens("microsoft", {"access_token": "T", "refresh_token": "R", "expires_in": 7200})
        info = manager.get_token_info("microsoft")
        assert info is not None
        for key in ("provider", "has_access_token", "has_refresh_token", "expires_at", "saved_at", "is_valid"):
            assert key in info, f"Missing key: {key}"
        assert info["provider"] == "microsoft"
        assert info["has_access_token"] is True
        assert info["has_refresh_token"] is True
        assert info["is_valid"] is True

    def test_token_info_missing_provider_returns_none(self, manager):
        assert manager.get_token_info("nonexistent") is None


# ---------------------------------------------------------------------------
# error paths
# ---------------------------------------------------------------------------
class TestErrorPaths:
    def test_corrupt_json_file_returns_empty_dict(self, manager, tmp_path):
        """Writing invalid JSON should cause _load_tokens_file to return {}."""
        os.makedirs(tmp_path / "oauth_cfg", exist_ok=True)
        with open(manager.tokens_file, "w", encoding="utf-8") as f:
            f.write("{this is not valid JSON!!")
        result = manager._load_tokens_file()
        assert result == {}

    def test_load_tokens_with_corrupt_json_returns_none(self, manager, tmp_path):
        """load_tokens on a corrupt file should return None gracefully."""
        os.makedirs(tmp_path / "oauth_cfg", exist_ok=True)
        with open(manager.tokens_file, "w", encoding="utf-8") as f:
            f.write("{broken")
        # Should not raise; returns None because no provider key in empty dict
        result = manager.load_tokens("microsoft")
        assert result is None

    def test_decrypt_failure_raises(self, manager):
        """Attempting to decrypt garbage data raises an exception."""
        with pytest.raises(Exception):
            manager._decrypt("not-valid-base64-or-fernet-data!!!!")

    def test_encrypt_decrypt_roundtrip(self, manager):
        """_encrypt / _decrypt must be exact inverses."""
        plaintext = "Hello, World! 1234 $%^"
        ciphertext = manager._encrypt(plaintext)
        assert ciphertext != plaintext
        recovered = manager._decrypt(ciphertext)
        assert recovered == plaintext

    def test_key_persisted_across_instances(self, tmp_path):
        """Two managers sharing the same config_dir reuse the same key."""
        from oauth2_token_manager import OAuth2TokenManager

        cfg = str(tmp_path / "shared_cfg")
        m1 = OAuth2TokenManager(config_dir=cfg)
        m1.save_tokens("ms", {"access_token": "abc123", "expires_in": 3600})

        m2 = OAuth2TokenManager(config_dir=cfg)
        loaded = m2.load_tokens("ms")
        assert loaded is not None
        assert loaded["access_token"] == "abc123"
