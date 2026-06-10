"""Gate 4 (Task 6) — hta_converter.py coverage top-up toward 80%.

Targets the previously-uncovered paths:
- convert_hta_for_transcription auto-path generation (lines 54-58)
- _convert_hta mp3 branch (line 107)
- _convert_hta unsupported format (lines 119-120)
- _parse_hta_format_1 resampling branch (lines 263, 279-284)
- _parse_hta_format_1 fallback error path (lines 312-318)
- _convert_to_mp3_direct (lines 373-446)
- _create_wav_file sample-rate adjustment (lines 456-462)
- _get_compatible_sample_rate all branches (lines 498-506)
- _resample_audio mono and stereo (lines 515-554)
- _verify_wav_file error paths (lines 568, 577-579)
- convert_hta_for_transcription module-level function (lines 645-646)
"""

import io
import os
import tempfile
import wave
from unittest.mock import MagicMock, Mock, patch

import pytest
from hta_converter import HTAConverter, convert_hta_for_transcription

pytestmark = pytest.mark.timeout(20)


# ---------------------------------------------------------------------------
# convert_hta_for_transcription — auto output_path (lines 54-58)
# ---------------------------------------------------------------------------


class TestConvertHtaForTranscriptionMethod:
    def test_auto_output_path_uses_temp_dir(self):
        """When no output_path provided, generates mp3 path in temp_dir."""
        converter = HTAConverter()
        captured = {}

        def capture_convert(hta_path, output_path):
            captured["output_path"] = output_path
            return output_path

        with patch("os.path.exists", return_value=True):
            with patch.object(converter, "_convert_to_mp3_direct", side_effect=capture_convert):
                result = converter.convert_hta_for_transcription("/some/dir/recording.hta")

        assert result is not None
        generated_path = captured["output_path"]
        assert "recording_transcription.mp3" in generated_path
        assert converter.temp_dir in generated_path

    def test_custom_output_path_passed_through(self):
        """When output_path is provided, it is passed directly to _convert_hta."""
        converter = HTAConverter()
        captured = {}

        def capture_convert(hta_path, output_path):
            captured["output_path"] = output_path
            return output_path

        with patch("os.path.exists", return_value=True):
            with patch.object(converter, "_convert_to_mp3_direct", side_effect=capture_convert):
                result = converter.convert_hta_for_transcription(
                    "/some/dir/recording.hta", output_path="/custom/out.mp3"
                )

        assert result == "/custom/out.mp3"
        assert captured["output_path"] == "/custom/out.mp3"


# ---------------------------------------------------------------------------
# _convert_hta — MP3 branch (line 107) and unsupported format (lines 119-120)
# ---------------------------------------------------------------------------


class TestConvertHtaBranches:
    def test_mp3_format_routes_to_convert_to_mp3_direct(self):
        """format_type='mp3' skips WAV pipeline and calls _convert_to_mp3_direct."""
        converter = HTAConverter()
        with patch("os.path.exists", return_value=True):
            with patch.object(converter, "_convert_to_mp3_direct", return_value="/tmp/out.mp3") as mock_mp3:
                result = converter._convert_hta("/tmp/audio.hta", "/tmp/out.mp3", "mp3")

        mock_mp3.assert_called_once_with("/tmp/audio.hta", "/tmp/out.mp3")
        assert result == "/tmp/out.mp3"

    def test_unsupported_format_returns_none(self):
        """Formats other than wav/mp3 return None after logging error."""
        converter = HTAConverter()
        mock_audio = b"\x00" * 100

        with patch("os.path.exists", return_value=True):
            with patch.object(converter, "_parse_hta_file", return_value=(mock_audio, 16000, 1)):
                result = converter._convert_hta("/tmp/audio.hta", "/tmp/out.ogg", "ogg")

        assert result is None


# ---------------------------------------------------------------------------
# _get_compatible_sample_rate — all branches (lines 498-506)
# ---------------------------------------------------------------------------


class TestGetCompatibleSampleRate:
    def setup_method(self):
        self.converter = HTAConverter()

    def test_already_compatible_16000(self):
        assert self.converter._get_compatible_sample_rate(16000) == 16000

    def test_already_compatible_44100(self):
        assert self.converter._get_compatible_sample_rate(44100) == 44100

    def test_already_compatible_22050(self):
        assert self.converter._get_compatible_sample_rate(22050) == 22050

    def test_already_compatible_48000(self):
        assert self.converter._get_compatible_sample_rate(48000) == 48000

    def test_already_compatible_8000(self):
        assert self.converter._get_compatible_sample_rate(8000) == 8000

    def test_close_to_16k_rounds_to_16000(self):
        """12000-20000 range (excluding already-compatible) → 16000."""
        assert self.converter._get_compatible_sample_rate(14000) == 16000
        assert self.converter._get_compatible_sample_rate(18000) == 16000

    def test_high_rate_rounds_to_44100(self):
        """Rates above 20000 (not already compatible) → 44100."""
        assert self.converter._get_compatible_sample_rate(32000) == 44100
        assert self.converter._get_compatible_sample_rate(96000) == 44100

    def test_very_low_rate_returns_8000(self):
        """Rates below 8000 (not already compatible) → 8000."""
        assert self.converter._get_compatible_sample_rate(4000) == 8000
        assert self.converter._get_compatible_sample_rate(11025) == 8000


# ---------------------------------------------------------------------------
# _resample_audio — mono and stereo (lines 515-554)
# ---------------------------------------------------------------------------


class TestResampleAudio:
    def setup_method(self):
        self.converter = HTAConverter()

    def test_resample_mono_upsampling(self):
        """Resample mono audio from 8000 Hz to 16000 Hz doubles samples."""
        import numpy as np

        # 100 mono samples at 16-bit
        original = np.zeros(100, dtype=np.int16)
        original_bytes = original.tobytes()

        result = self.converter._resample_audio(original_bytes, 8000, 16000, 1)

        # Roughly double the number of samples
        result_samples = len(result) // 2
        assert result_samples == pytest.approx(200, abs=2)

    def test_resample_stereo_upsampling(self):
        """Resample stereo audio from 16000 Hz to 32000 Hz doubles samples."""
        import numpy as np

        # 100 stereo frames at 16-bit (interleaved)
        original = np.zeros((100, 2), dtype=np.int16)
        original_bytes = original.tobytes()

        result = self.converter._resample_audio(original_bytes, 16000, 32000, 2)

        # Roughly double the number of stereo frames
        result_frames = len(result) // (2 * 2)  # 2 channels * 2 bytes per sample
        assert result_frames == pytest.approx(200, abs=2)

    def test_resample_no_numpy_falls_back(self):
        """When numpy is not available, returns original audio data unchanged."""
        original_bytes = b"\x00\x01" * 50

        with patch.dict("sys.modules", {"numpy": None}):
            result = self.converter._resample_audio(original_bytes, 8000, 16000, 1)

        assert result == original_bytes

    def test_resample_handles_exception(self):
        """If resampling raises, returns original data."""
        original_bytes = b"\x00\x01" * 50

        with patch("hta_converter.np", create=True):
            # Patch numpy to raise during frombuffer
            with patch("numpy.frombuffer", side_effect=ValueError("bad buffer")):
                result = self.converter._resample_audio(original_bytes, 8000, 16000, 1)

        # Should return original data on failure
        assert result == original_bytes


# ---------------------------------------------------------------------------
# _parse_hta_format_1 — resampling paths (lines 263, 279-284, 312-318)
# ---------------------------------------------------------------------------


class TestParseHtaFormat1Resampling:
    def setup_method(self):
        self.converter = HTAConverter()

    def test_no_resample_when_rate_matches(self):
        """When frame_rate already equals target, set_frame_rate is NOT called."""
        mock_segment = Mock()
        mock_segment.frame_rate = 16000  # Already matches target
        mock_segment.channels = 1
        mock_segment.__len__ = Mock(return_value=1000)
        mock_segment.set_sample_width.return_value = mock_segment
        # set_frame_rate should NOT be called since rates already match

        mock_export_data = b"RIFF" + b"\x00" * 100

        def mock_export(io_obj, format):
            io_obj.write(mock_export_data)

        mock_segment.export.side_effect = mock_export

        with patch("pydub.AudioSegment") as mock_audio_cls:
            mock_audio_cls.from_file.return_value = mock_segment
            with patch.object(self.converter, "_parse_wav_data", return_value=(b"audio", 16000, 1)):
                result = self.converter._parse_hta_format_1(b"\xff\xe0" + b"\x00" * 100)

        # set_frame_rate should not have been called
        mock_segment.set_frame_rate.assert_not_called()
        assert result == (b"audio", 16000, 1)

    def test_resample_when_rate_differs(self):
        """When frame_rate differs from target, set_frame_rate IS called."""
        mock_segment = Mock()
        mock_segment.frame_rate = 32000  # Will map to 44100 via _get_compatible_sample_rate
        mock_segment.channels = 1
        mock_segment.__len__ = Mock(return_value=1000)
        # set_sample_width returns a new mock with same frame_rate (still needs resampling check)
        resampled_segment = Mock()
        resampled_segment.frame_rate = 32000  # After set_sample_width, still 32000
        resampled_segment.channels = 1
        resampled_segment.__len__ = Mock(return_value=1000)
        resampled2 = Mock()
        resampled2.frame_rate = 44100
        resampled2.channels = 1
        resampled2.__len__ = Mock(return_value=1000)

        mock_segment.set_sample_width.return_value = resampled_segment
        resampled_segment.set_frame_rate.return_value = resampled2

        mock_export_data = b"RIFF" + b"\x00" * 100

        def mock_export(io_obj, format):
            io_obj.write(mock_export_data)

        resampled2.export.side_effect = mock_export

        with patch("pydub.AudioSegment") as mock_audio_cls:
            mock_audio_cls.from_file.return_value = mock_segment
            with patch.object(self.converter, "_parse_wav_data", return_value=(b"audio", 44100, 1)):
                result = self.converter._parse_hta_format_1(b"\xff\xe0" + b"\x00" * 100)

        # set_frame_rate was called with the target rate
        resampled_segment.set_frame_rate.assert_called_once_with(44100)

    def test_pydub_import_error_returns_none(self):
        """ImportError from pydub in _parse_hta_format_1 falls back to H1E settings."""
        with patch.dict("sys.modules", {"pydub": None, "pydub.AudioSegment": None}):
            result = self.converter._parse_hta_format_1(b"\xff\xe0" + b"\x00" * 100)

        # Should fallback to H1E raw settings
        assert result[1] == 16000
        assert result[2] == 1


# ---------------------------------------------------------------------------
# _convert_to_mp3_direct (lines 373-446)
# ---------------------------------------------------------------------------


class TestConvertToMp3Direct:
    def setup_method(self):
        self.converter = HTAConverter()

    def test_successful_mp3_conversion(self, tmp_path):
        """_convert_to_mp3_direct calls AudioSegment and exports MP3."""
        output_path = str(tmp_path / "out.mp3")

        mock_segment = Mock()
        mock_segment.frame_rate = 16000
        mock_segment.channels = 1
        mock_segment.set_sample_width.return_value = mock_segment
        mock_segment.set_frame_rate.return_value = mock_segment

        with patch("pydub.AudioSegment") as mock_cls:
            mock_cls.from_file.return_value = mock_segment
            result = self.converter._convert_to_mp3_direct("/tmp/audio.hta", output_path)

        mock_segment.export.assert_called_once()
        assert result == output_path

    def test_mp3_conversion_falls_back_to_auto_detect(self, tmp_path):
        """When format='mp3' fails, falls back to auto-detect."""
        output_path = str(tmp_path / "out.mp3")

        mock_segment = Mock()
        mock_segment.frame_rate = 16000
        mock_segment.channels = 1
        mock_segment.set_sample_width.return_value = mock_segment
        mock_segment.set_frame_rate.return_value = mock_segment

        def from_file_side_effect(path, format=None):
            if format == "mp3":
                raise Exception("mp3 format failed")
            return mock_segment

        with patch("pydub.AudioSegment") as mock_cls:
            mock_cls.from_file.side_effect = from_file_side_effect
            result = self.converter._convert_to_mp3_direct("/tmp/audio.hta", output_path)

        assert result == output_path

    def test_both_load_attempts_fail_returns_none(self, tmp_path):
        """When both mp3 and auto-detect fail, returns None."""
        output_path = str(tmp_path / "out.mp3")

        with patch("pydub.AudioSegment") as mock_cls:
            mock_cls.from_file.side_effect = Exception("all formats failed")
            result = self.converter._convert_to_mp3_direct("/tmp/audio.hta", output_path)

        assert result is None

    def test_pydub_import_error_returns_none(self, tmp_path):
        """When pydub is not available, returns None."""
        output_path = str(tmp_path / "out.mp3")

        with patch.dict("sys.modules", {"pydub": None}):
            result = self.converter._convert_to_mp3_direct("/tmp/audio.hta", output_path)

        assert result is None

    def test_resampling_applied_when_needed(self, tmp_path):
        """When frame_rate != target, set_frame_rate is called."""
        output_path = str(tmp_path / "out.mp3")

        mock_segment = Mock()
        mock_segment.frame_rate = 32000  # Will map to 44100
        mock_segment.channels = 1

        resampled = Mock()
        resampled.frame_rate = 44100
        resampled.channels = 1

        mock_segment.set_sample_width.return_value = mock_segment
        mock_segment.set_frame_rate.return_value = resampled

        with patch("pydub.AudioSegment") as mock_cls:
            mock_cls.from_file.return_value = mock_segment
            result = self.converter._convert_to_mp3_direct("/tmp/audio.hta", output_path)

        mock_segment.set_frame_rate.assert_called_once_with(44100)

    def test_audio_segment_is_none_returns_none(self, tmp_path):
        """If segment ends up None (unlikely but defensive), returns None."""
        output_path = str(tmp_path / "out.mp3")

        with patch("pydub.AudioSegment") as mock_cls:
            mock_cls.from_file.return_value = None
            result = self.converter._convert_to_mp3_direct("/tmp/audio.hta", output_path)

        assert result is None

    def test_general_exception_returns_none(self, tmp_path):
        """Unexpected exceptions are caught and return None."""
        output_path = str(tmp_path / "out.mp3")

        mock_segment = Mock()
        mock_segment.frame_rate = 16000
        mock_segment.channels = 1
        mock_segment.set_sample_width.return_value = mock_segment
        mock_segment.set_frame_rate.return_value = mock_segment
        mock_segment.export.side_effect = RuntimeError("disk full")

        with patch("pydub.AudioSegment") as mock_cls:
            mock_cls.from_file.return_value = mock_segment
            result = self.converter._convert_to_mp3_direct("/tmp/audio.hta", output_path)

        assert result is None


# ---------------------------------------------------------------------------
# _create_wav_file — sample rate adjustment path (lines 456-462)
# ---------------------------------------------------------------------------


class TestCreateWavFileRateAdjustment:
    def setup_method(self):
        self.converter = HTAConverter()

    def test_incompatible_sample_rate_is_resampled(self, tmp_path):
        """When sample_rate is not compatible, _resample_audio is called."""
        output_file = str(tmp_path / "out.wav")
        # 32000 Hz is not in the compatible list and > 20000, so maps to 44100
        audio_data = b"\x00\x01" * 100

        with patch.object(self.converter, "_resample_audio", return_value=audio_data) as mock_resample:
            with patch.object(self.converter, "_verify_wav_file"):
                self.converter._create_wav_file(output_file, audio_data, 32000, 1)

        mock_resample.assert_called_once_with(audio_data, 32000, 44100, 1)

    def test_compatible_sample_rate_no_resampling(self, tmp_path):
        """When sample_rate is already compatible, _resample_audio is NOT called."""
        output_file = str(tmp_path / "out.wav")
        audio_data = b"\x00\x01" * 100  # 100 samples of 16-bit PCM

        with patch.object(self.converter, "_resample_audio") as mock_resample:
            with patch.object(self.converter, "_verify_wav_file"):
                self.converter._create_wav_file(output_file, audio_data, 16000, 1)

        mock_resample.assert_not_called()


# ---------------------------------------------------------------------------
# _verify_wav_file — error paths (lines 568, 577-579)
# ---------------------------------------------------------------------------


class TestVerifyWavFile:
    def setup_method(self):
        self.converter = HTAConverter()

    def test_verify_raises_when_no_frames(self, tmp_path):
        """Raises ValueError when WAV file has zero frames."""
        wav_file = str(tmp_path / "empty.wav")

        # Create a WAV file with 0 frames
        with wave.open(wav_file, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(b"")  # No frames

        with pytest.raises(ValueError, match="no audio frames"):
            self.converter._verify_wav_file(wav_file)

    def test_verify_raises_on_corrupt_wav(self, tmp_path):
        """Raises ValueError when WAV file is corrupt/unreadable."""
        corrupt_file = str(tmp_path / "corrupt.wav")
        with open(corrupt_file, "wb") as f:
            f.write(b"NOT_A_WAV_FILE")

        with pytest.raises((ValueError, Exception)):
            self.converter._verify_wav_file(corrupt_file)

    def test_verify_valid_wav_returns_true(self, tmp_path):
        """Returns True for valid WAV file with audio frames."""
        wav_file = str(tmp_path / "valid.wav")

        with wave.open(wav_file, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(b"\x00\x01" * 100)

        result = self.converter._verify_wav_file(wav_file)
        assert result is True


# ---------------------------------------------------------------------------
# convert_hta_for_transcription module-level convenience function (lines 645-646)
# ---------------------------------------------------------------------------


class TestConvertHtaForTranscriptionFunction:
    def test_module_level_function_delegates_to_converter(self):
        """Module-level convert_hta_for_transcription delegates to HTAConverter."""
        import hta_converter

        # Reset global singleton so we get a fresh one
        hta_converter._hta_converter = None

        with patch("os.path.exists", return_value=True):
            with patch.object(HTAConverter, "_convert_to_mp3_direct", return_value="/tmp/out.mp3"):
                result = convert_hta_for_transcription("/tmp/audio.hta", "/tmp/out.mp3")

        assert result == "/tmp/out.mp3"

    def test_module_level_function_auto_path(self):
        """Module-level function generates output path when not provided."""
        import hta_converter

        hta_converter._hta_converter = None

        with patch("os.path.exists", return_value=True):
            with patch.object(HTAConverter, "_convert_to_mp3_direct", return_value="/tmp/audio_transcription.mp3"):
                result = convert_hta_for_transcription("/tmp/audio.hta")

        assert result == "/tmp/audio_transcription.mp3"
