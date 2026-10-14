"""Projection regressions use analytic directions, independent of the generated picture."""
import importlib.util
import json
import sys
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from equirectangular import Equirectangular, close_spherical_edges, sun_direction
from map_assets import FACES, cube_rays

spec = importlib.util.spec_from_file_location('prepare_cubemap', ROOT / 'scripts/prepare-cubemap.py')
cubemap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cubemap)


class GeneratedMapTest(unittest.TestCase):
    def test_sun_on_cube_face_recovers_world_direction(self):
        sun = np.array([-.4, .8, .5])
        sun /= np.linalg.norm(sun)
        uv = [(.4 / .8 + 1) / 2, (.5 / .8 + 1) / 2]
        np.testing.assert_allclose(cubemap.direction_from_face('top', uv), sun)
        with self.assertRaises(ValueError):
            cubemap.direction_from_face('top', [float('nan'), .5])

    def test_edge_review_matches_twelve_edges_and_detects_misoriented_faces(self):
        # A continuous world-direction colour field must match across the cube.
        images = {face: Image.fromarray(np.uint8(np.rint((cube_rays(face, 512) + 1) * 127.5))) for face in FACES}
        edges = cubemap.assess_edges(images)
        self.assertEqual(len(edges), 12)
        self.assertLess(max(edge['meanAbsoluteRGBDifference'] for edge in edges), 1)
        images['left'] = images['left'].transpose(Image.Transpose.FLIP_TOP_BOTTOM)
        mismatched = cubemap.assess_edges(images)
        self.assertGreater(max(edge['meanAbsoluteRGBDifference'] for edge in mismatched), 40)

    def test_hd_import_rejects_missing_faces_and_changed_sources(self):
        with self.assertRaises(ValueError):
            cubemap.load_sources({'sources': {}})
        config = {'sources': {direction: {'file': 'package.json', 'sha256': 'invalid'} for direction in cubemap.INPUT_FACES}}
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            cubemap.load_sources(config)

    def test_cube_face_centres_match_three_image_cube_convention(self):
        centres = [(-1, 0, 0), (1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
        for face, expected in zip(FACES, centres):
            np.testing.assert_allclose(cube_rays(face, 1)[0, 0], expected)
            np.testing.assert_allclose(np.linalg.norm(cube_rays(face, 9), axis=-1), 1)

    def test_sampler_wraps_longitude_and_clamps_poles(self):
        # Each longitude column has a distinct red value, latitude a green value.
        source = np.zeros((4, 8, 3), dtype=np.uint8)
        source[:, :, 0] = np.arange(8) * 20
        source[:, :, 1] = np.arange(4)[:, None] * 50
        rays = np.array([[[1, 0, 0], [0, 0, 1], [0, 0, -1], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]], dtype=float)
        result = Equirectangular(source).render(rays)[0]
        np.testing.assert_array_equal(result[:, 0], [70, 110, 30, 70, 70, 70])
        np.testing.assert_array_equal(result[:, 1], [75, 75, 75, 75, 0, 150])
        near_seam = np.array([[[-1, 0, 1e-8], [-1, 0, -1e-8]]])
        np.testing.assert_array_equal(*Equirectangular(source).render(near_seam)[0])

    def test_heading_rotates_texture_and_sun_together(self):
        source = np.zeros((180, 360, 3), dtype=np.uint8)
        source[44:46, 269:271] = 255  # u=.75, v=.25: elevation45, azimuth90.
        np.testing.assert_allclose(sun_direction([.75, .25], 90), [2**-.5, 2**-.5, 0], atol=1e-10)
        for heading in (0, 30, 90, 350):
            ray = np.array([[sun_direction([.75, .25], heading)]])
            np.testing.assert_array_equal(Equirectangular(source, heading).render(ray)[0, 0], [255]*3)

    def test_narrow_correction_closes_seam_and_poles_preserving_front(self):
        source = np.random.default_rng(0).integers(0, 256, (180, 360, 3), dtype=np.uint8)
        corrected = close_spherical_edges(source, 4, 2)
        np.testing.assert_array_equal(corrected[:, 0], corrected[:, -1])
        self.assertEqual(len(np.unique(corrected[0], axis=0)), 1)
        self.assertEqual(len(np.unique(corrected[-1], axis=0)), 1)
        np.testing.assert_array_equal(corrected[2:-2, 4:-4], source[2:-2, 4:-4])
        np.testing.assert_array_equal(close_spherical_edges(source, 0, 0), source)

    def test_reject_bad_projection_calibration_and_changed_source(self):
        with self.assertRaises(ValueError):
            Equirectangular(np.zeros((12, 12, 3)))
        for uv in ([.5, .75], [float('nan'), .2], [2, .2]):
            with self.assertRaises(ValueError):
                sun_direction(uv)
        with self.assertRaises(ValueError):
            Equirectangular(np.zeros((4, 8, 3)), float('nan'))
        spec = importlib.util.spec_from_file_location('prepare_generated', ROOT / 'scripts/prepare-generated-map.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        config = json.loads((ROOT / 'scripts/maps/river-meadow.json').read_text())
        config['sourceSha256'] = 'incorrect'
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            module.prepare(config, ROOT / config['source'])


if __name__ == '__main__':
    unittest.main()
