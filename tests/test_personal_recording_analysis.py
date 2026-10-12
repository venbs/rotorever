from pathlib import Path
import sys
import unittest
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from analyze_personal_recording import GRAVITY, projected_acceleration, point_mask, fit_force


class PersonalRecordingAnalysisTest(unittest.TestCase):
    def test_force_projection_removes_gravity_for_tilted_aircraft(self):
        t = np.array([0, .027, .063, .089, .121])
        angle = .7
        rotation = np.array([[np.cos(angle), -np.sin(angle), 0],
                             [np.sin(angle), np.cos(angle), 0], [0, 0, 1]])
        force = 31.5
        acceleration = rotation[:, 1] * force - np.array([0, GRAVITY, 0])
        velocity = t[:, None] * acceleration
        measured = projected_acceleration(velocity, np.repeat(rotation[None], len(t), axis=0), t)
        np.testing.assert_allclose(measured, force, atol=1e-10)

    def test_bad_interval_excludes_both_centered_derivatives(self):
        np.testing.assert_array_equal(point_mask(np.array([True, True, False, True, True])),
                                      [False, True, False, False, True, False])

    def test_force_fit_recovers_independent_control_and_speed_coefficients(self):
        rng = np.random.default_rng(35)
        collective, velocity = rng.uniform(-1, 1, (2, 120))
        force = -1.25 + 100.5 * collective - 4.8 * velocity
        fit = fit_force(collective, velocity, force, np.ones(120, dtype=bool))
        self.assertTrue(fit['usable'])
        self.assertAlmostEqual(fit['offset'], -1.25)
        self.assertAlmostEqual(fit['collectiveGain'], 100.5)
        self.assertAlmostEqual(fit['axialVelocityGain'], -4.8)
        self.assertLess(fit['rmsAcceleration'], 1e-10)


if __name__ == '__main__':
    unittest.main()
