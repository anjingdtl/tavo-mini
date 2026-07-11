import xml.etree.ElementTree as ET
import re
import sys

xml_path = sys.argv[1] if len(sys.argv) > 1 else 'window_dump.xml'
tree = ET.parse(xml_path)
root = tree.getroot()

def find(node, pattern):
    text = node.get('text', '') or ''
    desc = node.get('content-desc', '') or ''
    if pattern in text or pattern in desc:
        return node
    for child in node:
        result = find(child, pattern)
        if result is not None:
            return result
    return None

for keyword in ['LLM 设置', 'LLM', '本地模型管理', '模型管理', '本地']:
    node = find(root, keyword)
    if node:
        bounds = node.get('bounds')
        print(f'{keyword}: {bounds}')
        if bounds:
            m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', bounds)
            if m:
                x1, y1, x2, y2 = map(int, m.groups())
                print(f'  center: ({(x1+x2)//2}, {(y1+y2)//2})')
