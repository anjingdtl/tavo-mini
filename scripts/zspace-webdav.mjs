#!/usr/bin/env node
/**
 * zspace-webdav.mjs — self-contained WebDAV uploader / lister for Zspace Z2Pro/Z4Pro.
 *
 * Usage:
 *   node scripts/zspace-webdav.mjs probe
 *   node scripts/zspace-webdav.mjs list [remoteSubdir]
 *   node scripts/zspace-webdav.mjs put  <localFile> [remoteName]
 *
 * Default target: 192.168.1.127:5005 (HTTP) -> user 18007718199.
 * Override via env:  ZSPACE_HOST ZSPACE_PORT ZSPACE_USER ZSPACE_PASS ZSPACE_REMOTE
 *
 * Verified 2026-07-10:
 *   - 31.6 MB PUT @ ~80 MB/s, HTTP 201 (new) / 204 (overwrite).
 *   - 30 B smoke file, HTTP 201 / 204.
 *
 * NOTE: This file deliberately does NOT import node:stream or node:fs.streams —
 *       Node 22.11.0's built-in fetch stream body buggy under some sandboxes.
 *       We use full Buffer PUT instead.
 */

import { stat, readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

const HOST  = process.env.ZSPACE_HOST  || '192.168.1.127';
const PORT  = Number(process.env.ZSPACE_PORT || 5005);
const USER  = process.env.ZSPACE_USER  || '18007718199';
const PASS  = process.env.ZSPACE_PASS  || '1985928@Hsh';
const RDIR  = process.env.ZSPACE_REMOTE || '/HDD-1/';
const AUTH  = 'Basic ' + Buffer.from(USER + ':' + PASS, 'utf8').toString('base64');

function joinUrl(remoteRel) {
  const dir = RDIR.endsWith('/') ? RDIR : RDIR + '/';
  return 'http://' + HOST + ':' + PORT + dir + encodeURIComponent(remoteRel);
}
function mb(n) { return (n / 1024 / 1024).toFixed(2) + ' MB'; }

async function probe() {
  const res = await fetch('http://' + HOST + ':' + PORT + '/', {
    method: 'PROPFIND',
    headers: { Depth: '0', Authorization: AUTH },
  });
  console.log('HTTP', res.status, res.statusText);
  process.exitCode = res.ok ? 0 : 1;
}

async function list() {
  const url = 'http://' + HOST + ':' + PORT + RDIR;
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: { Depth: '1', Authorization: AUTH },
  });
  if (!res.ok) {
    console.error('LIST failed: HTTP', res.status);
    process.exit(1);
  }
  const xml = await res.text();
  const entries = [];
  const entryRe = /<D:response>([\s\S]*?)<\/D:response>/g;
  const hrefRe = /<D:href>([^<]+)<\/D:href>/;
  const lenRe  = /<D:getcontentlength>([^<]+)<\/D:getcontentlength>/;
  const ctRe   = /<D:getcontenttype>([^<]+)<\/D:getcontenttype>/;
  let m;
  while ((m = entryRe.exec(xml))) {
    const body = m[1];
    const href = (body.match(hrefRe) || [])[1];
    if (!href || href === RDIR || href.endsWith(RDIR + 'index.html')) continue;
    const len = (body.match(lenRe) || [])[1];
    const ct  = (body.match(ctRe)  || [])[1] || '';
    if (!len) continue;
    // strip leading dir prefix like '/HDD-1/' from href
    const name = decodeURIComponent(href.replace(new RegExp('^.*' + RDIR.replace(/\//g, '\\/')), ''));
    entries.push({ name, size: Number(len), type: ct });
  }
  entries.sort((a, b) => b.size - a.size);
  for (const e of entries) {
    console.log(mb(e.size).padStart(10) + '  ' + e.name + '  [' + e.type + ']');
  }
  console.error('(' + entries.length + ' entries)');
}

async function put(localPath, remoteName) {
  const abs = resolve(localPath);
  const st = await stat(abs);
  if (!st.isFile()) throw new Error('Not a file: ' + abs);
  const name = remoteName || basename(abs);
  const url  = joinUrl(name);

  console.error('PUT', abs, '(' + mb(st.size) + ')', '->', url);
  const t0 = Date.now();
  const buf = await readFile(abs);

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: AUTH,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(buf.length),
    },
    body: buf,
  });

  const ms = Date.now() - t0;
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error('HTTP', res.status, '-', txt.slice(0, 200));
    process.exit(1);
  }
  console.log('HTTP', res.status, '|', mb(buf.length), '|', (ms/1000).toFixed(2) + 's', '|', (buf.length / ms / 1024).toFixed(1), 'MB/s');
}

const [, , cmd, ...args] = process.argv;
try {
  if (cmd === 'probe') await probe();
  else if (cmd === 'list') await list();
  else if (cmd === 'put') await put(args[0], args[1]);
  else {
    console.error('Usage: node scripts/zspace-webdav.mjs {probe|list|put <file> [name]}');
    process.exit(2);
  }
} catch (e) {
  console.error('ERR:', e.message);
  process.exit(1);
}
