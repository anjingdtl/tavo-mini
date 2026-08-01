import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

const serial = process.argv[2] || 'emulator-5554';
const outPath = process.argv[3] || null;
execFileSync('adb', ['-s', serial, 'shell', 'uiautomator', 'dump', '/sdcard/ui-agent.xml'], {
  stdio: 'pipe',
});
const raw = execFileSync('adb', ['-s', serial, 'exec-out', 'cat', '/sdcard/ui-agent.xml'], {
  maxBuffer: 20 * 1024 * 1024,
});
const s = raw.toString('utf8');
if (outPath) fs.writeFileSync(outPath, s, 'utf8');
const texts = [...s.matchAll(/text="([^"]*)"/g)].map(m => m[1]).filter(Boolean);
const descs = [...s.matchAll(/content-desc="([^"]*)"/g)].map(m => m[1]).filter(Boolean);
console.log('=== texts ===');
for (const t of [...new Set(texts)]) console.log(t);
console.log('=== descs ===');
for (const t of [...new Set(descs)]) console.log(t);
