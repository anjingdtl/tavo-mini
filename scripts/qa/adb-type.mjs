/**
 * Type ASCII text via adb keyevents (no IME / clipboard dependency).
 * Usage: node scripts/qa/adb-type.mjs --serial emulator-5554 --text "https://api.deepseek.com"
 */
import {execFileSync} from 'node:child_process';

const args = process.argv.slice(2);
function getFlag(name, def = null) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  return args[i + 1] ?? def;
}

const serial = getFlag('--serial', 'emulator-5554');
const text = getFlag('--text', '');
if (!text) {
  console.error('Usage: node adb-type.mjs --serial emulator-5554 --text "..."');
  process.exit(2);
}

try {
  execFileSync(
    'adb',
    [
      '-s',
      serial,
      'shell',
      'ime',
      'set',
      'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME',
    ],
    {stdio: 'pipe'},
  );
} catch {
  // ignore
}

function shellInput(argsArr) {
  execFileSync('adb', ['-s', serial, 'shell', ...argsArr], {stdio: 'pipe'});
}

// Android KEYCODE map for common punctuation used in URLs/keys/models
const CODE = {
  a: 29,
  b: 30,
  c: 31,
  d: 32,
  e: 33,
  f: 34,
  g: 35,
  h: 36,
  i: 37,
  j: 38,
  k: 39,
  l: 40,
  m: 41,
  n: 42,
  o: 43,
  p: 44,
  q: 45,
  r: 46,
  s: 47,
  t: 48,
  u: 49,
  v: 50,
  w: 51,
  x: 52,
  y: 53,
  z: 54,
  '0': 7,
  '1': 8,
  '2': 9,
  '3': 10,
  '4': 11,
  '5': 12,
  '6': 13,
  '7': 14,
  '8': 15,
  '9': 16,
  '.': 56,
  '-': 69,
  '/': 76,
  ' ': 62,
};

const SHIFT = 59; // KEYCODE_SHIFT_LEFT
const SEMICOLON = 74; // with SHIFT → :

for (const ch of text) {
  const lower = ch.toLowerCase();
  if (ch === ':') {
    shellInput(['input', 'keyevent', String(SHIFT), String(SEMICOLON)]);
    continue;
  }
  if (ch === '_') {
    shellInput(['input', 'keyevent', String(SHIFT), String(CODE['-'])]);
    continue;
  }
  if (/[A-Z]/.test(ch)) {
    shellInput(['input', 'keyevent', String(SHIFT), String(CODE[lower])]);
    continue;
  }
  const code = CODE[ch];
  if (code == null) {
    console.error('unsupported char codepoint', ch.charCodeAt(0));
    process.exit(3);
  }
  shellInput(['input', 'keyevent', String(code)]);
}

console.log('typed keyevents len=' + text.length);
