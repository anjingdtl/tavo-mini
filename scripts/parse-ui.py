#!/usr/bin/env python3
"""Parse uiautomator dump XML and print clickable + editable elements with bounds."""
import sys
import xml.etree.ElementTree as ET
import re

def center(b):
    m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', b)
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    return ((x1 + x2) // 2, (y1 + y2) // 2)

def main():
    if len(sys.argv) < 2:
        print('Usage: parse-ui.py <ui.xml>')
        sys.exit(1)
    tree = ET.parse(sys.argv[1])
    root = tree.getroot()
    rows = []
    for node in root.iter('node'):
        cls = node.get('class', '')
        desc = node.get('content-desc', '')
        text = node.get('text', '')
        clickable = node.get('clickable') == 'true'
        focusable = node.get('focusable') == 'true'
        bounds = node.get('bounds', '')
        if not (clickable or 'EditText' in cls or 'Button' in cls):
            continue
        c = center(bounds)
        if not c:
            continue
        label = desc or text or cls.split('.')[-1]
        if not label.strip():
            continue
        rows.append((label, c[0], c[1], clickable, 'EditText' in cls))
    for label, x, y, click, edit in rows:
        flag = 'E' if edit else ('C' if click else '?')
        print(f'{label[:30]:<32} ({x:>4},{y:>4}) [{flag}]')

if __name__ == '__main__':
    main()
