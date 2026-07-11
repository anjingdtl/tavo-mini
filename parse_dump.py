import xml.etree.ElementTree as ET
import sys

tree = ET.parse(sys.argv[1])
root = tree.getroot()

def walk(node, depth=0):
    text = node.attrib.get('text', '')
    desc = node.attrib.get('content-desc', '')
    cls = node.attrib.get('class', '')
    bounds = node.attrib.get('bounds', '')
    if text or desc:
        label = text or desc
        print(f"{'  ' * depth}{cls}: {label} [{bounds}]")
    for child in node:
        walk(child, depth + 1)

walk(root)
