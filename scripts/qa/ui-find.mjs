import {execFileSync} from 'node:child_process';

const serial = process.argv[2] || 'emulator-5554';
const needle = process.argv[3] || '';
execFileSync('adb', ['-s', serial, 'shell', 'uiautomator', 'dump', '/sdcard/ui-agent.xml'], {
  stdio: 'pipe',
});
const s = execFileSync('adb', ['-s', serial, 'exec-out', 'cat', '/sdcard/ui-agent.xml'], {
  maxBuffer: 20 * 1024 * 1024,
}).toString('utf8');
const nodes = [...s.matchAll(/<node\b[^>]*>/g)].map(m => m[0]);
let i = 0;
for (const n of nodes) {
  const text = (n.match(/text="([^"]*)"/) || [])[1] || '';
  const desc = (n.match(/content-desc="([^"]*)"/) || [])[1] || '';
  const cls = (n.match(/class="([^"]*)"/) || [])[1] || '';
  const clickable = /clickable="true"/.test(n);
  const b = n.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!b) continue;
  const hay = `${text} ${desc} ${cls}`;
  if (!needle || hay.includes(needle)) {
    console.log(
      JSON.stringify({
        i: i++,
        text,
        desc,
        cls: cls.split('.').pop(),
        clickable,
        bounds: [+b[1], +b[2], +b[3], +b[4]],
        cx: Math.floor((+b[1] + +b[3]) / 2),
        cy: Math.floor((+b[2] + +b[4]) / 2),
      }),
    );
  }
}
