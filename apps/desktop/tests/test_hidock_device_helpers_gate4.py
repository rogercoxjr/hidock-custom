"""Gate 4 (Task 6) — pure-helper tests for hidock_device (no USB).

Targets the whole-app floor (Part 1); hidock_device.py is deliberately NOT
in the per-module 80% allowlist (it is fused with USB hardware).
"""

import struct
from unittest.mock import Mock

import pytest
from constants import CMD_GET_FILE_LIST
from hidock_device import HiDockJensen

pytestmark = pytest.mark.timeout(20)


@pytest.fixture
def jensen():
    dev = HiDockJensen(Mock())
    dev.sequence_id = 0
    return dev


class TestBuildPacket:
    def test_build_packet_header_shape(self, jensen):
        body = b"\x01\x02\x03"
        packet = jensen._build_packet(CMD_GET_FILE_LIST, body)

        # sync marker
        assert packet[0] == 0x12 and packet[1] == 0x34
        cmd_id, seq_id, body_len = struct.unpack(">HII", packet[2:12])
        assert cmd_id == CMD_GET_FILE_LIST
        assert seq_id == 1  # sequence_id incremented from 0
        assert body_len == len(body)
        assert packet[12:] == body

    def test_build_packet_empty_body(self, jensen):
        packet = jensen._build_packet(CMD_GET_FILE_LIST)
        _, _, body_len = struct.unpack(">HII", packet[2:12])
        assert body_len == 0
        assert len(packet) == 12

    def test_sequence_id_increments(self, jensen):
        p1 = jensen._build_packet(CMD_GET_FILE_LIST)
        p2 = jensen._build_packet(CMD_GET_FILE_LIST)
        seq1 = struct.unpack(">I", p1[4:8])[0]
        seq2 = struct.unpack(">I", p2[4:8])[0]
        assert seq2 == seq1 + 1


class TestReceiveLengthParse:
    """Verify that _receive_response correctly applies 24-bit body-length masking.

    The 4-byte length field in the Jensen response header encodes:
        bits 31-24 : checksum_len  (upper byte)
        bits 23-0  : body_len      (lower 3 bytes)

    _receive_response must extract body_len via ``& 0x00FFFFFF`` and only
    return ``body_len`` bytes — NOT ``body_len + checksum_len``.

    We drive this by building a hand-crafted packet, injecting it into
    ``receive_buffer``, and calling ``_receive_response`` with the mock
    endpoints/device wired up to deliver no further data (all reads timeout
    immediately, so the function processes only what's already buffered).
    """

    def _build_response_packet(self, cmd_id: int, seq_id: int, body: bytes, checksum_len: int = 0) -> bytes:
        """Build a raw Jensen response packet with an explicit checksum_len in the upper byte."""
        raw_len = (checksum_len << 24) | len(body)
        header = struct.pack(">BBHII", 0x12, 0x34, cmd_id, seq_id, raw_len)
        # Append body + checksum_len dummy bytes
        checksum_bytes = b"\xCC" * checksum_len
        return header + body + checksum_bytes

    def _make_connected_jensen(self) -> HiDockJensen:
        """Return a HiDockJensen instance that looks connected (no USB I/O)."""
        dev = HiDockJensen(Mock())
        dev.sequence_id = 5

        # Wire up as if connected
        dev.device = Mock()
        dev.ep_in = Mock()
        dev.ep_out = Mock()
        dev.ep_in.wMaxPacketSize = 512
        dev.ep_in.bEndpointAddress = 0x82
        dev.is_connected_flag = True

        # Any read from the device times out immediately so only the pre-filled
        # buffer is processed.
        import usb.core
        dev.device.read = Mock(side_effect=usb.core.USBTimeoutError("timeout"))

        return dev

    def test_24bit_body_length_masking(self):
        """Body returned is lower 24 bits only; checksum bytes are stripped."""
        dev = self._make_connected_jensen()

        # Build a packet: 3-byte body, checksum_len=1
        # raw length field = (0x01 << 24) | 3 = 0x01000003
        body = b"\xAA\xBB\xCC"
        packet = self._build_response_packet(
            cmd_id=CMD_GET_FILE_LIST,
            seq_id=5,  # matches dev.sequence_id, so it's accepted
            body=body,
            checksum_len=1,
        )

        # Inject the entire packet into the receive buffer before calling
        dev.receive_buffer.extend(packet)

        response = dev._receive_response(expected_seq_id=5, timeout_ms=200)

        assert response is not None, "_receive_response returned None — packet was not parsed"
        # body length must be 3 (lower 24 bits), not 4 (3 + checksum_len=1)
        assert len(response["body"]) == 3, (
            f"Expected body length 3 (24-bit mask applied), got {len(response['body'])}"
        )
        assert response["body"] == body

    def test_zero_checksum_len_works(self):
        """Standard packet with checksum_len=0 is parsed correctly."""
        dev = self._make_connected_jensen()

        body = b"\x01\x02\x03\x04\x05"
        packet = self._build_response_packet(
            cmd_id=CMD_GET_FILE_LIST, seq_id=5, body=body, checksum_len=0
        )
        dev.receive_buffer.extend(packet)

        response = dev._receive_response(expected_seq_id=5, timeout_ms=200)

        assert response is not None
        assert len(response["body"]) == 5
        assert response["body"] == body

    def test_large_checksum_len_not_included_in_body(self):
        """Non-zero checksum bytes at end of packet are excluded from returned body."""
        dev = self._make_connected_jensen()

        body = b"\x11\x22"
        packet = self._build_response_packet(
            cmd_id=CMD_GET_FILE_LIST, seq_id=5, body=body, checksum_len=4
        )
        dev.receive_buffer.extend(packet)

        response = dev._receive_response(expected_seq_id=5, timeout_ms=200)

        assert response is not None
        # body must be exactly 2 bytes, checksum (4 bytes) must not appear
        assert len(response["body"]) == 2
        assert response["body"] == body
