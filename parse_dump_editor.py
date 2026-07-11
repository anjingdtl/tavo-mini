import xml.etree.ElementTree as ET
import re
import sys

xml_path = sys.argv[1] if len(sys.argv) > 1 else 'window_dump.xml'
tree = ET.parse(xml_path)
root = tree.getroot()

def walk(node, depth=0):
    text = node.get('text', '') or ''
    desc = node.get('content-desc', '') or ''
    bounds = node.get('bounds', '')
    clickable = node.get('clickable', '')
    cls = node.get('class', '')
    if text or desc or clickable == 'true':
        label = text or desc or cls
        print(f'{"  "*depth}{label[:70]:70} | clickable={clickable} | {bounds}')
    for child in node:
        walk(child, depth+1)

walk(root)
