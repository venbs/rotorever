"""Reversible, version-locked patch of the local HELI-X manual recorder interval.

Only one CONSTANT_Long in net/HeliX/v/b.class changes: 30,000,000 ns ->
10,000,000 ns. No physics, licensing, scheduler implementation, timestamps,
playback, or recording fields are changed. Refuses unknown class versions.
Prepare and verify before using --install. A running HELI-X must be restarted.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import zipfile

ENTRY = 'net/HeliX/v/b.class'
KNOWN_CLASS_SHA = '49f0bdac62fa18821d24cf2872383d21a930ba75770a51099ff8f4589c68cc82'
DEFAULT_SOURCE = Path('/Users/bytedance/Library/HELI-X11/HeliX11.jar')
DEFAULT_OUT = Path(__file__).resolve().parents[1] / 'analysis/helix-recorder-100hz'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def constant_longs(data):
    if data[:4] != bytes.fromhex('cafebabe'):
        raise ValueError('Not a Java class')
    count = struct.unpack_from('>H', data, 8)[0]
    offset, index, result = 10, 1, []
    while index < count:
        tag = data[offset]
        offset += 1
        if tag == 1:
            offset += 2 + struct.unpack_from('>H', data, offset)[0]
        elif tag in (3, 4, 9, 10, 11, 12, 17, 18):
            offset += 4
        elif tag in (5, 6):
            if tag == 5:
                result.append((index, offset, struct.unpack_from('>q', data, offset)[0]))
            offset += 8
            index += 1
        elif tag in (7, 8, 16, 19, 20):
            offset += 2
        elif tag == 15:
            offset += 3
        else:
            raise ValueError(f'Unknown constant tag {tag}')
        index += 1
    return result


def patch_class(original):
    if sha(original) != KNOWN_CLASS_SHA:
        raise ValueError('Unknown or already modified recorder class; no patch applied')
    constants = [c for c in constant_longs(original) if c[2] == 30_000_000]
    if len(constants) != 1 or constants[0][0] != 38:
        raise ValueError('Recorder constant is not at the verified constant-pool index')
    _, offset, _ = constants[0]
    patched = original[:offset] + struct.pack('>q', 10_000_000) + original[offset + 8:]
    assert len(patched) == len(original)
    assert [(i, v) for i, _, v in constant_longs(patched) if i == 38] == [(38, 10_000_000)]
    return patched, offset


def verify_archive(original_path, patched_path):
    with zipfile.ZipFile(original_path) as original, zipfile.ZipFile(patched_path) as patched:
        if original.namelist() != patched.namelist():
            raise ValueError('Archive entries changed')
        if patched.testzip() is not None:
            raise ValueError('Archive CRC failure')
        changed = [name for name in original.namelist() if original.read(name) != patched.read(name)]
        if changed != [ENTRY]:
            raise ValueError(f'Unexpected changed entries: {changed}')
        expected, _ = patch_class(original.read(ENTRY))
        if patched.read(ENTRY) != expected:
            raise ValueError('Patched recorder does not match the approved byte change')
        return len(original.namelist())


def prepare(source, out):
    if source.is_symlink():
        raise ValueError('Refusing a symlink source')
    if out.exists():
        raise ValueError('Output folder already exists; refusing to overwrite a backup')
    with zipfile.ZipFile(source) as jar:
        if any(n.upper().startswith('META-INF/') and n.upper().endswith(('.SF', '.RSA', '.DSA', '.EC')) for n in jar.namelist()):
            raise ValueError('Signed archive; no signature modification is performed')
        replacement, offset = patch_class(jar.read(ENTRY))
        out.mkdir(parents=True)
        backup = out / 'HeliX11.original.jar'
        shutil.copy2(source, backup)
        patched = out / 'HeliX11.100hz.jar'
        with zipfile.ZipFile(patched, 'w') as dest:
            dest.comment = jar.comment
            for info in jar.infolist():
                dest.writestr(info, replacement if info.filename == ENTRY else jar.read(info.filename))
    entries = verify_archive(backup, patched)
    manifest = {'source': str(source), 'preparedAt': datetime.now().astimezone().isoformat(),
                'originalSha256': sha(backup.read_bytes()), 'patchedSha256': sha(patched.read_bytes()),
                'entry': ENTRY, 'entryOffset': offset, 'constantPoolIndex': 38,
                'originalIntervalNs': 30_000_000, 'targetIntervalNs': 10_000_000,
                'archiveEntries': entries, 'changedEntries': [ENTRY],
                'installed': False, 'runtimeRecordingVerified': False,
                'note': 'Target 100 Hz; actual unique samples depend on scheduler/state updates. Restart required.'}
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest, indent=2))


def install(out, restore=False):
    manifest_path = out / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if not restore and manifest.get('disabledReason'):
        raise ValueError(f"Installation disabled: {manifest['disabledReason']}")
    source = Path(manifest['source'])
    if source != DEFAULT_SOURCE or source.is_symlink():
        raise ValueError('Only the inspected local user JAR may be installed/restored')
    backup, patched = out / 'HeliX11.original.jar', out / 'HeliX11.100hz.jar'
    verify_archive(backup, patched)
    if sha(backup.read_bytes()) != manifest['originalSha256'] or sha(patched.read_bytes()) != manifest['patchedSha256']:
        raise ValueError('Prepared files changed; refusing installation')
    expected = manifest['patchedSha256'] if restore else manifest['originalSha256']
    if sha(source.read_bytes()) != expected:
        raise ValueError('Installed JAR changed since preparation; refusing overwrite')
    staged = source.with_name('.HeliX11.jar.recorder-update.tmp')
    data = (backup if restore else patched).read_bytes()
    # Exclusive staging and atomic replace avoid mixing old and new ZIP data.
    with staged.open('xb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(staged, source.stat().st_mode & 0o777)
    os.replace(staged, source)
    assert sha(source.read_bytes()) == sha(data)
    manifest['installed'] = not restore
    manifest['lastOperation'] = 'restore' if restore else 'install'
    manifest['lastOperationAt'] = datetime.now().astimezone().isoformat()
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'source': str(source), 'operation': manifest['lastOperation'], 'restartRequired': True,
                      'sha256': sha(data)}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--prepare', action='store_true')
    mode.add_argument('--install', action='store_true')
    mode.add_argument('--restore', action='store_true')
    parser.add_argument('--source', type=Path, default=DEFAULT_SOURCE)
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    if args.prepare:
        prepare(args.source, args.out)
    else:
        install(args.out, args.restore)
