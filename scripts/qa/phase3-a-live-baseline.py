#!/usr/bin/env python3
"""Drive Outline/Continuation x fast/standard/quality x 2 chapters on device."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

SERIAL = os.environ.get("ANDROID_SERIAL", "emulator-5554")
PACKAGE = "com.shinewriter"
ACTIVITY = "com.shinewriter/.MainActivity"
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "test-logs"
OUT.mkdir(exist_ok=True)


def sdk() -> Path:
    for key in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        val = os.environ.get(key)
        if val:
            return Path(val)
    return Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk"


def adb(*args: str) -> str:
    cmd = [str(sdk() / "platform-tools" / "adb.exe"), "-s", SERIAL, *args]
    r = subprocess.run(cmd, capture_output=True)
    out = r.stdout.decode("utf-8", "replace")
    err = r.stderr.decode("utf-8", "replace")
    if r.returncode != 0 and err.strip():
        print(err.strip(), file=sys.stderr)
    return out


def dump_xml() -> str:
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    raw = subprocess.run(
        [
            str(sdk() / "platform-tools" / "adb.exe"),
            "-s",
            SERIAL,
            "exec-out",
            "cat",
            "/sdcard/ui.xml",
        ],
        capture_output=True,
    ).stdout
    return raw.decode("utf-8", "replace")


def nodes(xml: str) -> list[dict]:
    out = []
    for tag in re.findall(r"<node\b[^>]*>", xml):
        text = (re.search(r'\btext="([^"]*)"', tag) or [None, ""])[1]
        desc = (re.search(r'\bcontent-desc="([^"]*)"', tag) or [None, ""])[1]
        rid = (re.search(r'\bresource-id="([^"]*)"', tag) or [None, ""])[1]
        b = re.search(r'\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', tag)
        if not b:
            continue
        x1, y1, x2, y2 = map(int, b.groups())
        out.append(
            {
                "text": text or "",
                "desc": desc or "",
                "id": rid.split("/")[-1] if rid else "",
                "x": (x1 + x2) // 2,
                "y": (y1 + y2) // 2,
                "clickable": 'clickable="true"' in tag,
                "hay": f"{text}|{desc}|{rid}",
            }
        )
    return out


def tap_xy(x: int, y: int) -> None:
    adb("shell", "input", "tap", str(x), str(y))
    time.sleep(1.2)


def visible(xml: str, needle: str) -> bool:
    return needle in xml


def find_node(xml: str, needle: str) -> dict | None:
    for n in nodes(xml):
        if needle in n["hay"] or n["id"] == needle:
            return n
    return None


def tap(needle: str, retries: int = 4) -> bool:
    for _ in range(retries):
        xml = dump_xml()
        n = find_node(xml, needle)
        if n:
            print(f"TAP {needle!r} @ {n['x']},{n['y']}")
            tap_xy(n["x"], n["y"])
            return True
        time.sleep(0.8)
    print(f"NOT_FOUND {needle!r}")
    return False


def wait_any(needles: list[str], timeout: int) -> str | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        xml = dump_xml()
        for needle in needles:
            if visible(xml, needle):
                return needle
        time.sleep(3)
    return None


def screenshot(name: str) -> None:
    dest = OUT / name
    adb("shell", "screencap", "-p", "/sdcard/a4.png")
    adb("pull", "/sdcard/a4.png", str(dest))


def set_quality(label: str) -> None:
    tap("设置")
    time.sleep(1)
    tap("流水线配置")
    time.sleep(1)
    tap(label)
    time.sleep(0.5)
    tap("保存配置")
    time.sleep(1.5)
    adb("shell", "input", "keyevent", "4")
    time.sleep(0.8)


def open_project(name: str, continuation: bool) -> None:
    tap("1 项目") or tap("项目")
    time.sleep(1)
    if continuation:
        tap("原著续写")
        time.sleep(0.8)
    else:
        tap("大纲创作")
        time.sleep(0.8)
    tap(name)
    time.sleep(1.5)


def add_and_open_chapter(title: str) -> None:
    tap("3 写作") or tap("写作") or tap("续写")
    time.sleep(1)
    if not tap("writing-add-chapter"):
        tap("新建章节") or tap("添加章节")
    time.sleep(1.5)
    if tap("chapter-title-input"):
        adb("shell", "input", "text", title.replace(" ", "_"))
        time.sleep(0.6)
    tap("chapter-content-input")
    time.sleep(0.4)


def generate_chapter(continuation: bool) -> dict:
    started = time.time()
    tap("chapter-ai-generate") or tap("AI 重新生成") or tap("AI 续写")
    time.sleep(1)
    tap("开始续写")
    tap("覆盖并生成")
    tap("确定")
    tap("继续")
    hit = wait_any(
        [
            "共享 Writing Kernel",
            "流水线结果",
            "续写结果",
            "流水线失败",
            "续写失败",
            "已保存",
        ],
        timeout=720,
    )
    ended = time.time()
    screenshot(f"a4-{int(started)}.png")
    if hit in ("流水线失败", "续写失败"):
        tap("稍后处理") or tap("确定")
    else:
        adb("shell", "input", "keyevent", "4")
        time.sleep(1)
    return {
        "generateStartedAt": started,
        "generateEndedAt": ended,
        "generateMs": int((ended - started) * 1000),
        "terminalHint": hit,
    }


def finalize_and_next() -> dict:
    started = time.time()
    tap("chapter-finalize") or tap("定稿")
    time.sleep(1)
    tap("确定")
    wait_any(["章节已定稿", "定稿失败", "已保存"], timeout=180)
    finalized = time.time()
    tap("下一章") or tap("开下一章")
    time.sleep(2)
    ready = time.time()
    return {
        "finalizeStartedAt": started,
        "finalizeEndedAt": finalized,
        "nextReadyAt": ready,
        "finalizeMs": int((finalized - started) * 1000),
        "finalizeToNextReadyMs": int((ready - finalized) * 1000),
    }


def main() -> int:
    adb("shell", "am", "start", "-n", ACTIVITY)
    time.sleep(4)
    records = []
    matrix = [
        ("outline", "Phase 3 穿测项目", False, "极速", "fast"),
        ("outline", "Phase 3 穿测项目", False, "标准", "standard"),
        ("outline", "Phase 3 穿测项目", False, "质量", "quality"),
        ("continuation", None, True, "极速", "fast"),
        ("continuation", None, True, "标准", "standard"),
        ("continuation", None, True, "质量", "quality"),
    ]
    xml = dump_xml()
    continuation_name = None
    for n in nodes(xml):
        if "原著续写" in n["hay"] and n["text"] and "（" not in n["text"]:
            continuation_name = n["text"]
            break
    # fallback from known projects after switching tab
    for scenario, project, is_cont, label, quality in matrix:
        set_quality(label)
        if is_cont:
            open_project("原著续写", True)
            time.sleep(1)
            xml = dump_xml()
            # tap first non-header continuation project card if name unknown
            if not tap("txt-import") and not continuation_name:
                for n in nodes(xml):
                    if n["clickable"] and n["text"] and "原著" not in n["text"] and "搜索" not in n["text"]:
                        tap_xy(n["x"], n["y"])
                        break
            else:
                tap(continuation_name or "原著")
        else:
            open_project(project, False)
        tap("3 写作") or tap("写作") or tap("续写")
        time.sleep(1)
        for index in (1, 2):
            title = f"A4-{scenario[:3]}-{quality}-{index}"
            add_and_open_chapter(title)
            gen = generate_chapter(is_cont)
            fin = finalize_and_next()
            rec = {
                "scenario": scenario,
                "quality": quality,
                "qualityLabel": label,
                "chapterIndex": index,
                "title": title,
                **gen,
                **fin,
            }
            records.append(rec)
            print(json.dumps(rec, ensure_ascii=False))
            adb("shell", "input", "keyevent", "4")
            time.sleep(1)
    payload = {"capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "records": records}
    (OUT / "phase3-a-live-baseline-ui.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("wrote", OUT / "phase3-a-live-baseline-ui.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
