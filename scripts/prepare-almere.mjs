import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

// Offline import only. Runtime never reads the HELI-X installation.
const source = process.argv[2] ?? '/Applications/HELI-X11.app/Contents/resources/environments/SkyBox/MVA-Almere';
const output = path.resolve('public/environments/mva-almere');
const faces = ['right', 'left', 'top', 'bottom', 'front', 'back'];
const exec = promisify(execFile);
const manifest = {
  name: 'MVA-Almere', author: '(C) Matthijs Amelink',
  source: 'HELI-X11 / MVA-Almere, user-supplied local installation',
  authorURL: 'https://www.360cities.net/profile/matthijs360',
  usage: 'Imported for this local prototype; original asset ownership is retained.',
  eyeHeight: 1.75, groundHeight: 0, lightDirection: [7, -18.25, 7],
  cubeOrder: faces, backgroundYawDegrees: 90,
  sourceConfigSha256: createHash('sha256').update(await readFile(path.join(source, 'MVA-Almere.xml'))).digest('hex'),
  sourceGroundSha256: createHash('sha256').update(await readFile(path.join(source, 'ground.xml'))).digest('hex'),
  tiers: {},
};
for (const [tier, size, quality] of [['preview', 256, 65], ['standard', 1536, 80]]) {
  await mkdir(path.join(output, tier), { recursive: true });
  const files = await Promise.all(faces.map(async face => {
    const input = path.join(source, '2048', `MVA-Almere_${face}.png`);
    const dest = path.join(output, tier, `${face}.webp`);
    await exec('cwebp', ['-quiet', '-q', String(quality), '-m', '6', '-mt', '-resize', String(size), String(size), input, '-o', dest]);
    return { file: `${tier}/${face}.webp`, bytes: (await stat(dest)).size,
      sourceBytes: (await stat(input)).size,
      sourceSha256: createHash('sha256').update(await readFile(input)).digest('hex'),
      sha256: createHash('sha256').update(await readFile(dest)).digest('hex') };
  }));
  manifest.tiers[tier] = { size, quality, bytes: files.reduce((n, f) => n + f.bytes, 0), files };
}
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest.tiers, null, 2));
