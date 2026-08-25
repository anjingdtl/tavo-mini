#!/usr/bin/env python3
"""Resume remaining Phase 3 A4 live LLM matrix.

Never dump UI during generation (uiautomator hangs). Dump only when idle.
"""
from __future__ import annotations

import argparse
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
LOG = OUT / "a4-remaining.log"


def sdk() -> Path:
    for key in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        val = os.environ.get(key)
        if val:
            return Path(val)
    return Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk"


def adb_bin() -> str:
    return str(sdk() / "platform-tools" / "adb.exe")


def adb(*args: str, timeout: int = 30) -> str:
    cmd = [adb_bin(), "-s", SERIAL, *args]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        log(f"ADB_TIMEOUT {' '.join(args)}")
        return ""
    out = r.stdout.decode("utf-8", "replace")
    err = r.stderr.decode("utf-8", "replace")
    if r.returncode != 0 and err.strip():
        log(f"ADB_ERR {' '.join(args)} :: {err.strip()[:400]}")
    return out


def log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def screenshot(name: str) -> Path:
    dest = OUT / name
    adb("shell", "screencap", "-p", "/sdcard/a4.png")
    adb("pull", "/sdcard/a4.png", str(dest))
    log(f"SHOT {dest.name}")
    return dest


def dump_xml(timeout: int = 20) -> str:
    try:
        subprocess.run(
            [adb_bin(), "-s", SERIAL, "shell", "uiautomator", "dump", "/sdcard/ui.xml"],
            capture_output=True,
            timeout=timeout,
        )
        raw = subprocess.run(
            [adb_bin(), "-s", SERIAL, "exec-out", "cat", "/sdcard/ui.xml"],
            capture_output=True,
            timeout=timeout,
        ).stdout
        return raw.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        log("DUMP_TIMEOUT")
        return ""


def nodes(xml: str) -> list[dict]:
    out = []
    for tag in re.findall(r"<node\b[^>]*>", xml):
        text = (re.search(r'\btext="([^"]*)"', tag) or [None, ""])[1] or ""
        desc = (re.search(r'\bcontent-desc="([^"]*)"', tag) or [None, ""])[1] or ""
        rid = (re.search(r'\bresource-id="([^"]*)"', tag) or [None, ""])[1] or ""
        b = re.search(r'\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', tag)
        if not b:
            continue
        x1, y1, x2, y2 = map(int, b.groups())
        out.append(
            {
                "text": text,
                "desc": desc,
                "id": rid.split("/")[-1] if rid else "",
                "x": (x1 + x2) // 2,
                "y": (y1 + y2) // 2,
                "w": x2 - x1,
                "h": y2 - y1,
                "hay": f"{text}|{desc}|{rid}",
            }
        )
    return out


def tap_xy(x: int, y: int, wait: float = 1.0) -> None:
    adb("shell", "input", "tap", str(x), str(y))
    time.sleep(wait)


def find_node(xml: str, needles: list[str]) -> dict | None:
    ns = nodes(xml)
    for needle in needles:
        for n in ns:
            if needle in n["hay"] or n["id"] == needle or n["text"] == needle or n["desc"] == needle:
                return n
    return None


def tap(needles: list[str] | str, retries: int = 5, wait: float = 1.1) -> bool:
    if isinstance(needles, str):
        needles = [needles]
    for attempt in range(retries):
        xml = dump_xml()
        n = find_node(xml, needles)
        if n:
            log(f"TAP {needles[0]!r} @ {n['x']},{n['y']} text={n['text']!r} desc={n['desc']!r}")
            tap_xy(n["x"], n["y"], wait)
            return True
        log(f"MISS {needles} try={attempt+1}")
        time.sleep(0.7)
    return False


def visible(xml: str, needle: str) -> bool:
    return needle in xml


def back(n: int = 1) -> None:
    for _ in range(n):
        adb("shell", "input", "keyevent", "4")
        time.sleep(0.8)


def swipe_up() -> None:
    adb("shell", "input", "swipe", "540", "1700", "540", "700", "400")
    time.sleep(0.8)


def launch() -> None:
    adb("shell", "am", "start", "-n", ACTIVITY)
    time.sleep(4)


def clear_logcat() -> None:
    adb("logcat", "-c")


def logcat_hint() -> str:
    raw = adb(
        "logcat",
        "-d",
        "-t",
        "80",
        "-s",
        "ReactNativeJS:V",
        "AndroidRuntime:E",
        timeout=20,
    )
    return raw[-4000:]


def wait_generation(tag: str, min_s: int, max_s: int) -> str:
    """Wait without dumping. After min_s, dump with timeout to detect terminal UI."""
    started = time.time()
    log(f"WAIT_GEN {tag} min={min_s}s max={max_s}s")
    time.sleep(max(8, min_s))
    last = "timeout"
    while time.time() - started < max_s:
        screenshot(f"a4_{tag}_{int(time.time()-started)}s.png")
        xml = dump_xml(timeout=18)
        if not xml:
            log("dump empty/timeout — still generating?")
            time.sleep(25)
            continue
        hints = [
            "采纳",
            "已采纳",
            "流水线失败",
            "续写失败",
            "网络请求失败",
            "Network request failed",
            "从失败处继续重跑",
            "重试",
            "AI 重新生成",
            "AI 续写",
            "共享 Writing Kernel",
            "流水线结果",
            "定稿",
        ]
        found = [h for h in hints if visible(xml, h)]
        log(f"UI_HINTS {found}")
        if any(h in found for h in ("采纳", "流水线结果", "共享 Writing Kernel")):
            return "result"
        if any(h in found for h in ("流水线失败", "续写失败", "网络请求失败", "Network request failed", "从失败处继续重跑")):
            return "failed"
        generating = visible(xml, "AI 生成中") or visible(xml, "生成中")
        if (visible(xml, "AI 重新生成") or visible(xml, "AI 续写") or visible(xml, "定稿")) and not generating:
            if visible(xml, "已保存") or visible(xml, "完成"):
                return "editor_done"
            # might still be on editor after auto-nav
            if time.time() - started > min_s + 20:
                return "editor"
        time.sleep(20)
    screenshot(f"a4_{tag}_timeout.png")
    return last


def dismiss_ok() -> None:
    xml = dump_xml()
    n = find_node(xml, ["确定", "OK", "button1"])
    if n:
        tap_xy(n["x"], n["y"])
        return
    tap_xy(894, 1336)


def adopt_if_possible() -> bool:
    xml = dump_xml()
    if visible(xml, "流水线失败") or visible(xml, "续写失败"):
        if tap(["查看任务详情"], retries=2):
            time.sleep(1.5)
        elif tap(["从失败处继续重跑"], retries=1):
            return False
        else:
            tap(["稍后处理"], retries=1)
            return False
    if tap(["采纳"], retries=4):
        time.sleep(1.2)
        dismiss_ok()
        time.sleep(1.0)
        return True
    return False


def finalize_and_next(tag: str) -> dict:
    started = time.time()
    if not tap(["chapter-finalize", "定稿"], retries=4):
        tap_xy(419, 880)
    time.sleep(1.2)
    tap(["确定"], retries=2)
    time.sleep(2.5)
    screenshot(f"a4_{tag}_finalized.png")
    swipe_up()
    swipe_up()
    if not tap(["下一章"], retries=4):
        log("NO next chapter button")
    time.sleep(1.5)
    screenshot(f"a4_{tag}_next.png")
    return {
        "finalizeMs": int((time.time() - started) * 1000),
        "finalizeToNextReadyMs": int((time.time() - started) * 1000),
    }


def set_quality(label: str) -> None:
    log(f"SET_QUALITY {label}")
    tap(["设置", "5 设置"], retries=3)
    time.sleep(0.8)
    if not tap(["流水线配置"], retries=4):
        tap_xy(540, 1188)
    time.sleep(1.0)
    if not tap([label], retries=3):
        coords = {"极速": (233, 449), "标准": (540, 449), "质量": (847, 449)}
        if label in coords:
            tap_xy(*coords[label])
    time.sleep(0.4)
    if not tap(["保存配置", "保存"], retries=3):
        tap_xy(540, 1624)
    time.sleep(1.2)
    back(1)


def open_outline_project() -> None:
    tap(["1 项目", "项目"], retries=3)
    time.sleep(0.8)
    tap(["大纲创作"], retries=2)
    time.sleep(0.6)
    if not tap(["Phase 3 穿测项目"], retries=4):
        tap_xy(540, 520)
    time.sleep(1.2)


def open_writing() -> None:
    if not tap(["3 写作", "写作"], retries=3):
        tap_xy(539, 2301)
    time.sleep(1.2)


def open_chapter_by_title(title: str) -> bool:
    open_writing()
    return tap([title], retries=4)


def add_chapter() -> None:
    open_writing()
    if not tap(["writing-add-chapter", "章节"], retries=3):
        tap_xy(960, 166)
    time.sleep(1.6)


def start_generate(continuation: bool) -> None:
    clear_logcat()
    labels = (
        ["chapter-ai-generate", "AI 续写", "AI 重新生成"]
        if continuation
        else ["chapter-ai-generate", "AI 重新生成", "AI 生成"]
    )
    if not tap(labels, retries=4):
        tap_xy(173, 880)
    time.sleep(1.2)
    tap(["开始续写", "覆盖并生成", "确定", "继续"], retries=2)
    time.sleep(1.0)


def run_one_chapter(
    tag: str,
    *,
    continuation: bool,
    quality: str,
    min_s: int,
    max_s: int,
    add_new: bool,
    open_title: str | None,
) -> dict:
    rec = {
        "tag": tag,
        "continuation": continuation,
        "quality": quality,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    if add_new:
        add_chapter()
    elif open_title:
        if not open_chapter_by_title(open_title):
            rec["error"] = f"open_failed:{open_title}"
            screenshot(f"a4_{tag}_open_fail.png")
            return rec
    gen_t0 = time.time()
    start_generate(continuation)
    hint = wait_generation(tag, min_s, max_s)
    rec["terminalHint"] = hint
    rec["generateMs"] = int((time.time() - gen_t0) * 1000)
    screenshot(f"a4_{tag}_terminal.png")
    adopted = adopt_if_possible()
    rec["adopted"] = adopted
    if hint == "failed" and not adopted:
        xml = dump_xml()
        if visible(xml, "从失败处继续重跑") or visible(xml, "重试"):
            tap(["从失败处继续重跑", "重试"], retries=2) or tap_xy(894, 1364)
            hint2 = wait_generation(tag + "_retry", min_s, max_s)
            rec["retryHint"] = hint2
            rec["generateMs"] = int((time.time() - gen_t0) * 1000)
            screenshot(f"a4_{tag}_retry_terminal.png")
            rec["adopted"] = adopt_if_possible()
    back(1)
    time.sleep(1.0)
    fin = finalize_and_next(tag)
    rec.update(fin)
    rec["endedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    log(json.dumps(rec, ensure_ascii=False))
    return rec


def open_continuation_project(name: str) -> None:
    tap(["1 项目", "项目"], retries=3)
    time.sleep(0.8)
    tap(["原著续写"], retries=3)
    time.sleep(0.8)
    if not tap([name], retries=4):
        # first card below header
        tap_xy(540, 620)
    time.sleep(1.2)
    if not tap(["3 续写", "续写", "3 写作"], retries=3):
        tap_xy(539, 2301)
    time.sleep(1.2)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--only",
        choices=["outline-quality", "continuation", "all", "outline-ch6-finalize"],
        default="all",
    )
    args = parser.parse_args()
    records = []
    launch()
    screenshot("a4_resume_start.png")

    if args.only in ("outline-ch6-finalize", "outline-quality", "all"):
        open_outline_project()
        if open_chapter_by_title("第 6 章"):
            fin = finalize_and_next("ol_std2_fin")
            records.append({"tag": "ol_std2_finalize", **fin})
            back(1)

    if args.only in ("outline-quality", "all"):
        set_quality("质量")
        open_outline_project()
        records.append(
            run_one_chapter(
                "ol_quality1",
                continuation=False,
                quality="quality",
                min_s=180,
                max_s=900,
                add_new=False,
                open_title="第 7 章",
            )
        )
        records.append(
            run_one_chapter(
                "ol_quality2",
                continuation=False,
                quality="quality",
                min_s=180,
                max_s=900,
                add_new=True,
                open_title=None,
            )
        )

    if args.only in ("continuation", "all"):
        matrix = [
            ("极速", "fast", 50, 240),
            ("标准", "standard", 120, 480),
            ("质量", "quality", 180, 900),
        ]
        for label, quality, min_s, max_s in matrix:
            set_quality(label)
            open_continuation_project("qa-cont-pdca-20260817")
            for idx in (1, 2):
                records.append(
                    run_one_chapter(
                        f"cont_{quality}{idx}",
                        continuation=True,
                        quality=quality,
                        min_s=min_s,
                        max_s=max_s,
                        add_new=True,
                        open_title=None,
                    )
                )

    payload = {
        "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "records": records,
    }
    dest = OUT / "phase3-a-live-remaining-ui.json"
    dest.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"wrote {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
