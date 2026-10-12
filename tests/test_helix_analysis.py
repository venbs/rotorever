import math
import sys
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from analyze_helix import body_rate_intervals, arrays
from helix_recording import parse_recording


class KinematicsTests(unittest.TestCase):
    def test_irregular_time_world_velocity_and_body_rotation(self):
        # Independent analytic trajectory: translation at (2,-1,3) m/s and
        # body-y rotation at 300 deg/s; timestamps deliberately nonuniform.
        times = [0, .027, .061, .092]
        chunks = []
        for t in times:
            angle = t * math.radians(300)
            c, s = math.cos(angle), math.sin(angle)
            rows = [[c, 0, s], [0, 1, 0], [-s, 0, c], [2*t, 10-t, 3*t],
                    [2, -1, 3, 0, 0, 0], [0, 0, 0, 0], [1, 1, 0, 0, 0, 0, 0], [round(t*1e6)]]
            chunks.append('\n'.join(' '.join(map(str, row)) for row in rows))
        r, rotation, t = arrays(parse_recording('\n\n'.join(chunks)))
        rate, angle = body_rate_intervals(rotation, t)
        np.testing.assert_allclose(rate[:, 1], math.radians(300), atol=1e-10)
        np.testing.assert_allclose(rate[:, [0, 2]], 0, atol=1e-10)
        np.testing.assert_allclose(np.diff(r[3][:, :3], axis=0) / np.diff(t)[:, None],
                                   np.tile([2, -1, 3], (3, 1)), atol=1e-10)
        np.testing.assert_allclose(angle, np.diff(t) * math.radians(300), atol=1e-10)

    def test_stationary_orientation_has_zero_rate(self):
        rate, angle = body_rate_intervals(np.tile(np.eye(3), (3, 1, 1)), np.array([0, .02, .055]))
        np.testing.assert_array_equal(rate, np.zeros((2, 3)))
        np.testing.assert_array_equal(angle, np.zeros(2))


if __name__ == '__main__':
    unittest.main()
