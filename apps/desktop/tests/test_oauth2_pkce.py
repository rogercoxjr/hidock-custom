"""
Gate 4 (Task 5) coverage for oauth2_pkce.

PKCE verifier/challenge generation per RFC 7636.
No network, no I/O — pure crypto (stdlib hashlib + base64 + secrets).
"""
import base64
import hashlib

import pytest


# ---------------------------------------------------------------------------
# generate_code_verifier
# ---------------------------------------------------------------------------
class TestGenerateCodeVerifier:
    def test_default_length_is_64(self):
        from oauth2_pkce import generate_code_verifier

        v = generate_code_verifier()
        assert len(v) == 64

    def test_minimum_length_43(self):
        from oauth2_pkce import generate_code_verifier

        v = generate_code_verifier(43)
        assert len(v) == 43

    def test_maximum_length_128(self):
        from oauth2_pkce import generate_code_verifier

        v = generate_code_verifier(128)
        assert len(v) == 128

    def test_characters_are_url_safe(self):
        """Verifier must only use unreserved characters per RFC 7636."""
        from oauth2_pkce import generate_code_verifier

        import re

        v = generate_code_verifier(64)
        # RFC 7636 allows A-Z a-z 0-9 - . _ ~
        assert re.fullmatch(r"[A-Za-z0-9\-._~]+", v), f"Invalid chars in verifier: {v!r}"

    def test_below_minimum_raises_value_error(self):
        from oauth2_pkce import generate_code_verifier

        with pytest.raises(ValueError, match="43"):
            generate_code_verifier(42)

    def test_above_maximum_raises_value_error(self):
        from oauth2_pkce import generate_code_verifier

        with pytest.raises(ValueError, match="128"):
            generate_code_verifier(129)

    def test_two_verifiers_are_different(self):
        """Verifiers are random — two calls should produce different values."""
        from oauth2_pkce import generate_code_verifier

        v1 = generate_code_verifier()
        v2 = generate_code_verifier()
        assert v1 != v2


# ---------------------------------------------------------------------------
# generate_code_challenge
# ---------------------------------------------------------------------------
class TestGenerateCodeChallenge:
    def test_challenge_matches_sha256_spec(self):
        """challenge must equal BASE64URL(SHA256(verifier))."""
        from oauth2_pkce import generate_code_challenge

        verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        expected_digest = hashlib.sha256(verifier.encode("ascii")).digest()
        expected_challenge = base64.urlsafe_b64encode(expected_digest).decode("utf-8").rstrip("=")

        assert generate_code_challenge(verifier) == expected_challenge

    def test_challenge_has_no_padding(self):
        """Base64url encoding must strip '=' padding per RFC 7636."""
        from oauth2_pkce import generate_code_challenge

        challenge = generate_code_challenge("a" * 64)
        assert "=" not in challenge

    def test_challenge_is_base64url(self):
        """Challenge must be URL-safe base64 (no '+' or '/')."""
        from oauth2_pkce import generate_code_challenge

        challenge = generate_code_challenge("b" * 64)
        assert "+" not in challenge
        assert "/" not in challenge


# ---------------------------------------------------------------------------
# generate_pkce_pair
# ---------------------------------------------------------------------------
class TestGeneratePKCEPair:
    def test_pair_has_correct_types(self):
        from oauth2_pkce import generate_pkce_pair

        verifier, challenge = generate_pkce_pair()
        assert isinstance(verifier, str)
        assert isinstance(challenge, str)

    def test_verifier_is_valid_length(self):
        from oauth2_pkce import generate_pkce_pair

        verifier, _ = generate_pkce_pair()
        assert 43 <= len(verifier) <= 128

    def test_challenge_derived_from_verifier(self):
        """Challenge must equal BASE64URL(SHA256(verifier))."""
        from oauth2_pkce import generate_code_challenge, generate_pkce_pair

        verifier, challenge = generate_pkce_pair()
        assert challenge == generate_code_challenge(verifier)


# ---------------------------------------------------------------------------
# verify_pkce
# ---------------------------------------------------------------------------
class TestVerifyPKCE:
    def test_correct_pair_verifies(self):
        from oauth2_pkce import generate_pkce_pair, verify_pkce

        verifier, challenge = generate_pkce_pair()
        assert verify_pkce(verifier, challenge) is True

    def test_wrong_verifier_does_not_verify(self):
        from oauth2_pkce import generate_pkce_pair, verify_pkce

        _, challenge = generate_pkce_pair()
        wrong_verifier, _ = generate_pkce_pair()
        assert verify_pkce(wrong_verifier, challenge) is False

    def test_tampered_challenge_does_not_verify(self):
        from oauth2_pkce import generate_pkce_pair, verify_pkce

        verifier, challenge = generate_pkce_pair()
        tampered = challenge[:-1] + ("A" if challenge[-1] != "A" else "B")
        assert verify_pkce(verifier, tampered) is False
