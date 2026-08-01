/**
 * Generate continuation QA fixtures under qa/fixtures/continuation/.
 * Large files are generated at runtime (not committed). Fixed seed for reproducibility.
 *
 * Usage:
 *   node scripts/qa/generate-continuation-fixtures.mjs
 *   node scripts/qa/generate-continuation-fixtures.mjs --large   # also 500KB/5MB/50MB
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'qa/fixtures/continuation');
const includeLarge = process.argv.includes('--large');

function ensureDir(dir) {
  fs.mkdirSync(dir, {recursive: true});
}

function writeText(rel, content) {
  const full = path.join(OUT, rel);
  ensureDir(path.dirname(full));
  fs.writeFileSync(full, content, 'utf8');
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return {rel, bytes: Buffer.byteLength(content, 'utf8'), sha256: hash};
}

function writeBuffer(rel, buf) {
  const full = path.join(OUT, rel);
  ensureDir(path.dirname(full));
  fs.writeFileSync(full, buf);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  return {rel, bytes: buf.length, sha256: hash};
}

function chapterBlock(n, body) {
  return `第${n}章 标题${n}\n\n${body}\n\n`;
}

function loremChinese(seed, chars) {
  // Deterministic pseudo-Chinese filler (CJK Unified Ideographs range sample)
  const base = '他走在雨夜里想起旧日的誓言风从巷口吹来带着远处灯火的气味岁月如刀刀锋却在沉默中钝去';
  let out = '';
  let x = seed >>> 0;
  while (out.length < chars) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out += base[x % base.length];
    if (out.length % 40 === 0) {
      out += '。';
    }
    if (out.length % 200 === 0) {
      out += '\n';
    }
  }
  return out.slice(0, chars);
}

const manifest = [];

// FX-001 single UTF-8 3 chapters
manifest.push(
  writeText(
    'single_utf8_3_chapters.txt',
    chapterBlock(1, '清晨，林远站在山门前，看着雾气散去。这是他离开宗门的第一天。') +
      chapterBlock(2, '市集喧闹，摊贩叫卖。他买了一柄旧剑，银两所剩无几。') +
      chapterBlock(3, '夜宿客栈，窗外风雨大作。他梦见师父最后的嘱托。'),
  ),
);

// FX-002 no final newline
manifest.push(
  writeText(
    'single_utf8_no_final_newline.txt',
    chapterBlock(1, '章节一内容。').trimEnd() +
      '\n\n' +
      chapterBlock(2, '章节二内容。').trimEnd(),
  ),
);

// FX-003 CRLF
manifest.push(
  writeText(
    'single_utf8_crlf.txt',
    (
      chapterBlock(1, '第一段 CRLF。') +
      chapterBlock(2, '第二段 CRLF。') +
      chapterBlock(3, '第三段 CRLF。')
    ).replace(/\n/g, '\r\n'),
  ),
);

// FX-004 UTF-8 BOM
manifest.push(
  writeBuffer(
    'single_utf8_bom.txt',
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(
        chapterBlock(1, '带 BOM 的第一章。') + chapterBlock(2, '带 BOM 的第二章。'),
        'utf8',
      ),
    ]),
  ),
);

// FX-005 GB18030 (encode via iconv-lite if available, else raw mapping for ASCII+common CJK)
function encodeGb18030Approx(text) {
  // Prefer TextEncoder path via child — Node has no built-in GB18030.
  // Write UTF-8 placeholder named for encoding tests that native module may detect differently;
  // for true GB18030 we use a minimal hand-encoded buffer of known Chinese.
  // Hand-encode: "第1章 测试\n\n内容甲。" in GBK/GB18030 common codes.
  try {
    // dynamic import of iconv-lite if present in project
    return null;
  } catch {
    return null;
  }
}

// Minimal GBK: 第=B5DA 1章=D5C2 测=B2E2 试=CAD4
const gbBody = Buffer.from([
  0xb5, 0xda, 0x31, 0xd5, 0xc2, 0x20, 0xb2, 0xe2, 0xca, 0xd4, 0x0a, 0x0a, 0xc4,
  0xda, 0xc8, 0xdd, 0xbc, 0xd2, 0xa1, 0xa3, 0x0a, 0x0a, 0xb5, 0xda, 0x32, 0xd5,
  0xc2, 0x20, 0xb2, 0xe2, 0xca, 0xd4, 0x0a, 0x0a, 0xc4, 0xda, 0xc8, 0xdd, 0xd2,
  0xbb, 0xa1, 0xa3, 0x0a,
]);
manifest.push(writeBuffer('single_gb18030.txt', gbBody));

// FX-006 empty
manifest.push(writeText('single_empty.txt', ''));

// FX-007 whitespace only
manifest.push(writeText('single_whitespace.txt', '   \n\t\n  \n'));

// FX-008 no chapter titles (fallback)
manifest.push(
  writeText(
    'single_no_chapter_titles.txt',
    '这是一段没有标准章节标题的长文。\n\n第二段继续叙述。\n\n第三段结束。\n',
  ),
);

// FX-009 duplicate titles
manifest.push(
  writeText(
    'single_duplicate_titles.txt',
    chapterBlock(1, '首次第一章。') +
      chapterBlock(1, '重复的第一章标题。') +
      chapterBlock(2, '第二章。'),
  ),
);

// FX-010 long title
const longTitle = '第1章 ' + '超长标题'.repeat(80);
manifest.push(
  writeText('single_long_title.txt', `${longTitle}\n\n正文内容。\n\n第2章 正常\n\n第二章正文。\n`),
);

// FX-011 malformed bytes
manifest.push(
  writeBuffer(
    'single_malformed_bytes.bin.txt',
    Buffer.from([0xe4, 0xb8, 0xad, 0xff, 0xfe, 0x80, 0x0a, 0xe6, 0x96, 0x87]),
  ),
);

// FX-012 100K one chapter
manifest.push(
  writeText(
    'single_100k_one_chapter.txt',
    `第1章 十万字单章\n\n${loremChinese(42, 100_000)}\n`,
  ),
);

// Multi-file FX-M01 ordered
for (const [i, label] of [
  [1, '卷一开端'],
  [2, '卷二中段'],
  [3, '卷三终章'],
]) {
  manifest.push(
    writeText(
      `multi/m01/part_0${i}.txt`,
      chapterBlock(i, `${label}：角色继续前行，情节推进 ${i}。`),
    ),
  );
}

// FX-M02 natural sort volumes
for (const n of [10, 2, 1]) {
  manifest.push(
    writeText(
      `multi/m02/volume_${n}.txt`,
      chapterBlock(n, `卷${n} 的正文内容，用于自然排序回退。`),
    ),
  );
}

// FX-M04 partial failure: 2 valid + 1 empty
manifest.push(
  writeText('multi/m04/ok_a.txt', chapterBlock(1, '有效文件 A。')),
);
manifest.push(
  writeText('multi/m04/ok_b.txt', chapterBlock(2, '有效文件 B。')),
);
manifest.push(writeText('multi/m04/bad_empty.txt', ''));

// FX-M05 all fail
manifest.push(writeText('multi/m05/empty1.txt', ''));
manifest.push(writeText('multi/m05/empty2.txt', ''));

// FX-M06 no trailing newline between files
manifest.push(
  writeText('multi/m06/part_a.txt', '第1章 A\n\n内容A无尾换行'),
);
manifest.push(
  writeText('multi/m06/part_b.txt', '第2章 B\n\n内容B。\n'),
);

// FX-M08 special names
manifest.push(
  writeText('multi/m08/文件 名（特殊）.txt', chapterBlock(1, '中文与空格文件名。')),
);
manifest.push(
  writeText('multi/m08/part#2 [copy].txt', chapterBlock(2, '特殊字符文件名。')),
);

if (includeLarge) {
  for (const [name, size] of [
    ['large_500kb.txt', 500 * 1024],
    ['large_5mb.txt', 5 * 1024 * 1024],
    ['large_50mb.txt', 50 * 1024 * 1024],
  ]) {
    const header = '第1章 大文件压力测试\n\n';
    const need = size - Buffer.byteLength(header, 'utf8');
    const body = loremChinese(7, Math.ceil(need / 3)); // CJK ~3 bytes
    let content = header + body;
    // trim/pad to approximate size
    const buf = Buffer.from(content, 'utf8');
    if (buf.length > size) {
      content = buf.subarray(0, size).toString('utf8');
    } else if (buf.length < size) {
      content += '。'.repeat(Math.ceil((size - buf.length) / 3));
    }
    manifest.push(writeText(name, content));
  }
}

const manifestPath = path.join(OUT, 'MANIFEST.json');
fs.writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      includeLarge,
      files: manifest,
    },
    null,
    2,
  ),
  'utf8',
);

console.log(`Wrote ${manifest.length} fixtures to ${OUT}`);
console.log(`Manifest: ${manifestPath}`);
