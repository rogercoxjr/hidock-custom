"""Gate 4 (Task 8) — production loop-termination guarantees for hidock_device.

These assert that list_files and _receive_all_chunks_for_parallel cannot
spin forever on a stuck mismatched-id packet stream. They are written TDD:
before the bound is added they fail via the 10s timeout marker; after the
bound they pass fast with a terminating status.
"""

from unittest.mock import Mock, patch

import pytest
from hidock_device import HiDockJensen

# Tighter than the module-level 20s elsewhere: a true spin must fail in 10s.
pytestmark = pytest.mark.timeout(10)


@pytest.fixture
def jensen():
    dev = HiDockJensen(Mock())
    dev.device = Mock()
    dev.ep_in = Mock()
    dev.ep_out = Mock()
    dev.is_connected_flag = True
    dev.device_info = {"versionNumber": 12345}
    return dev


def test_list_files_terminates_on_stuck_mismatched_packet(jensen):
    """A never-ending stream of wrong-id packets must terminate, not hang."""
    with patch.object(jensen, "_send_command", return_value=1):
        with patch.object(jensen, "_receive_response") as mock_receive:
            # Constant mismatched id: hits the list_files else: continue branch.
            mock_receive.return_value = {"id": 999, "sequence": 1, "body": b"junk"}
            result = jensen.list_files()

    # Must return a finite error result rather than spinning forever.
    assert result is not None
    assert result["totalFiles"] == 0


def test_parallel_receive_terminates_on_stuck_mismatched_packet(jensen):
    """_receive_all_chunks_for_parallel must terminate on stuck wrong-id packets."""
    with patch.object(jensen, "_send_command", return_value=1):
        with patch.object(jensen, "_receive_response") as mock_receive:
            mock_receive.return_value = {"id": 999, "sequence": 1, "body": b"junk"}
            # timeout_s is positional in _receive_all_chunks_for_parallel(self, timeout_s)
            chunks = jensen._receive_all_chunks_for_parallel(5)

    # Returns the (empty) chunk list rather than hanging.
    assert chunks == []
