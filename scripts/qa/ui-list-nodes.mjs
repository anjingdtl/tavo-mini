#!/usr/bin/env node
// Dump filtered UI tree nodes by text/content-desc keyword for emulator automation.
// Usage: node ui-list-nodes.mjs <xml-file> <keyword>
import fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';

const xmlPath = process.argv[2];
const keyword = process.argv[3] ?? '';
if (!xmlPath) {
  console.error('usage: ui-list-nodes.mjs <xml-file> [keyword]');
  process.exit(2);
}
const raw = fs.readFileSync(xmlPath, 'utf8');
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  trimValues: false,
  textNodeName: '#text',
});
const tree = parser.parse(raw);

const wanted = keyword.split(',').map(s => s.trim()).filter(Boolean);
let printed = 0;

const visit = (n) => {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) {
    n.forEach(visit);
    return;
  }
  if (n.bounds !== undefined) {
    const t = n['#text'] ?? n.text ?? '';
    const d = n['content-desc'] ?? '';
    if (!wanted.length || wanted.some(w => String(t).includes(w) || String(d).includes(w))) {
      const clk = n.clickable === 'true' ? ' [CLICK]' : '';
      console.log(`${n.bounds}${clk} text=${JSON.stringify(t)} desc=${JSON.stringify(d)}`);
      printed++;
    }
    if (n.node) visit(n.node);
  } else {
    for (const v of Object.values(n)) visit(v);
  }
};
visit(tree);
process.stderr.write(`printed=${printed} wanted=${JSON.stringify(wanted)}\n`);