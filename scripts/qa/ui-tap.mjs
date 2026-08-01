import {execFileSync} from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
function getFlag(name, def = null) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  return args[i + 1] ?? def;
}
function hasFlag(name) {
  return args.includes(name);
}

const serial = getFlag('--serial', 'emulator-5554');
const match = getFlag('--match');
const partial = hasFlag('--partial');
const longPress = hasFlag('--long-press');
const index = Number(getFlag('--index', '0'));
const dumpOut = getFlag('--dump');

if (!match) {
  console.error('Usage: node ui-tap.mjs --serial emulator-5554 --match TEXT [--partial] [--index 0] [--long-press] [--dump path]');
  process.exit(2);
}

execFileSync('adb', ['-s', serial, 'shell', 'uiautomator', 'dump', '/sdcard/ui-agent.xml'], {
  stdio: 'pipe',
});
const raw = execFileSync('adb', ['-s', serial, 'exec-out', 'cat', '/sdcard/ui-agent.xml'], {
  maxBuffer: 20 * 1024 * 1024,
});
const s = raw.toString('utf8');
if (dumpOut) fs.writeFileSync(dumpOut, s, 'utf8');

const nodes = [...s.matchAll(/<node\b[^>]*>/g)].map(m => m[0]);
const hits = [];
for (const n of nodes) {
  const text = (n.match(/text="([^"]*)"/) || [])[1] || '';
  const desc = (n.match(/content-desc="([^"]*)"/) || [])[1] || '';
  const b = n.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!b) continue;
  const bounds = {l: +b[1], t: +b[2], r: +b[3], b: +b[4]};
  const hay = `${text}\n${desc}`;
  const ok = partial ? hay.includes(match) : text === match || desc === match;
  if (ok) {
    hits.push({
      text,
      desc,
      bounds,
      cx: Math.floor((bounds.l + bounds.r) / 2),
      cy: Math.floor((bounds.t + bounds.b) / 2),
    });
  }
}

if (!hits.length) {
  console.error(`No node matching '${match}' partial=${partial}; nodes=${nodes.length}`);
  process.exit(1);
}
if (index >= hits.length) {
  console.error(`Index ${index} out of range; matches=${hits.length}`);
  for (const h of hits) console.error(JSON.stringify(h));
  process.exit(1);
}

const h = hits[index];
console.log(
  `TAP text=${JSON.stringify(h.text)} desc=${JSON.stringify(h.desc)} at ${h.cx},${h.cy}`,
);
if (longPress) {
  execFileSync('adb', [
    '-s',
    serial,
    'shell',
    'input',
    'swipe',
    String(h.cx),
    String(h.cy),
    String(h.cx),
    String(h.cy),
    '800',
  ]);
} else {
  execFileSync('adb', ['-s', serial, 'shell', 'input', 'tap', String(h.cx), String(h.cy)]);
}
