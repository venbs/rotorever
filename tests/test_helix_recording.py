"""Synthetic fixtures only; no third-party flight files required."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from helix_recording import parse_recording


def frame(time=0, extended=True):
    rows = ['1 0 0', '0 1 0', '0 0 1', '0 10 0', '1 2 3 0 0 0', '.2 .3 -.4 .5', '1 1 0 0 0 0 0', str(time)]
    if extended:
        rows[3] += ' 0 0 0 0'
        rows[4] += ' 0 0 0'
        rows[5] += ' 0 0 0 0 .5 .5 0 .5'
        rows[6] += ' 0'
    return '\n'.join(rows) + '\n\n'


class RecordingTests(unittest.TestCase):
    def test_both_layouts_and_units_preserved(self):
        for extended in [False, True]:
            result = parse_recording(frame(0, extended) + frame(30000, extended))
            self.assertEqual(result.frames, 2)
            self.assertEqual(result.rows[1][7][0], 30000)
            self.assertEqual(result.rows[0][5][:4], [.2, .3, -.4, .5])
            self.assertEqual(result.schema, 'extended' if extended else 'legacy')

    def test_missing_final_blank_and_crlf(self):
        self.assertEqual(parse_recording(frame().strip().replace('\n', '\r\n')).frames, 1)

    def test_bad_inputs_rejected(self):
        cases = ['', frame().replace('1 0 0', 'NaN 0 0', 1), frame().replace('.2 .3', 'bad .3'),
                 frame(0) + frame(0), frame(2) + frame(1), frame(1.5), frame(-1),
                 frame(0) + frame(30000, False), '\n'.join(frame().splitlines()[:7])]
        for text in cases:
            with self.subTest(text=text[:30]), self.assertRaises(ValueError):
                parse_recording(text)


if __name__ == '__main__':
    unittest.main()
