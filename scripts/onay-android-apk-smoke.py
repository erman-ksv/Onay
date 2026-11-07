#!/usr/bin/env python3
"""Run an actual packaged Onay APK without Metro on Android emulator; collect screenshots/XML.
No SMS, API server, login credentials, or real ride dispatch.
"""
import argparse
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path


def adb(*args, timeout=45, check=True):
    cmd = ["adb", *args]
    result = subprocess.run(cmd, encoding="utf-8", stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"{' '.join(cmd)} -> {result.returncode}: {result.stdout[-400:]} {result.stderr[-400:]}")
    return result.stdout


def ui_tree():
    adb("shell", "uiautomator", "dump", "/sdcard/onay-window.xml", timeout=50)
    source = adb("shell", "cat", "/sdcard/onay-window.xml", timeout=30)
    return ET.fromstring(source), source


def bounds(node):
    raw = node.attrib.get("bounds", "")
    values = list(map(int, re.findall(r"\d+", raw)))
    if len(values) != 4:
        raise ValueError(f"Bad UI bounds: {raw}")
    x1, y1, x2, y2 = values
    return (x1 + x2) // 2, (y1 + y2) // 2


def find_node(root, query, mode="any"):
    for node in root.iter("node"):
        attrs = node.attrib
        properties = [attrs.get("text", ""), attrs.get("content-desc", ""), attrs.get("resource-id", "")]
        if mode == "id" and query in properties[2]:
            return node
        if mode == "text" and query in properties[0]:
            return node
        if mode == "desc" and query in properties[1]:
            return node
        if mode == "any" and any(query in value for value in properties):
            return node
    return None


def await_node(query, mode="any", timeout=35):
    deadline = time.monotonic() + timeout
    last = ""
    while time.monotonic() < deadline:
        try:
            root, last = ui_tree()
            node = find_node(root, query, mode)
            if node is not None:
                return node
        except Exception as exc:
            last = str(exc)
        time.sleep(2)
    raise AssertionError(f"Onay element '{query}' not rendered ({mode}); last tree={str(last)[-4000:]}")


def click(query, mode="any"):
    node = await_node(query, mode=mode)
    x, y = bounds(node)
    adb("shell", "input", "tap", str(x), str(y))
    time.sleep(1)


def screenshot(out, name):
    path = out / f"{name}.png"
    data = subprocess.run(["adb", "exec-out", "screencap", "-p"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40, check=True).stdout
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise AssertionError(f"Invalid Android screenshot {name}")
    path.write_bytes(data)


def xml_snapshot(out, name):
    _, source = ui_tree()
    (out / f"{name}.xml").write_text(source, encoding="utf-8")


def verify_languages(out, label):
    for value in ("RU", "UZ", "KZ"):
        await_node(value, "any")
    screenshot(out, label)
    xml_snapshot(out, label)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version-code", type=int, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    result = {"apk": args.apk.name, "versionCode": args.version_code, "checks": [], "status": "failed"}
    try:
        apk = args.apk.resolve()
        if not apk.is_file():
            raise RuntimeError(f"Missing APK: {apk}")
        adb("wait-for-device", timeout=160)
        adb("shell", "settings", "put", "global", "window_animation_scale", "0")
        adb("shell", "settings", "put", "global", "transition_animation_scale", "0")
        adb("shell", "settings", "put", "global", "animator_duration_scale", "0")
        adb("install", "-r", str(apk), timeout=180)
        pkg = adb("shell", "dumpsys", "package", "uz.tezjet.app", timeout=35)
        match = re.search(r"versionCode=(\d+)", pkg)
        if not match or int(match.group(1)) != args.version_code:
            raise AssertionError(f"Device versionCode != {args.version_code}: {match.group(0) if match else '(absent)'}")
        result["checks"].append("Android PackageManager versionCode matches checked APK")
        adb("shell", "am", "force-stop", "uz.tezjet.app")
        adb("shell", "monkey", "-p", "uz.tezjet.app", "-c", "android.intent.category.LAUNCHER", "1", timeout=35)
        await_node("Посмотреть без SMS", timeout=90)
        screenshot(args.output, "android-auth-entry")
        click("Посмотреть без SMS")
        await_node("ДЕМО ONAY", timeout=45)
        # Bottom pill contains four tabs, of which inactive icons have accessible labels.
        click("onay-tab-profile", "id")
        await_node("Личные данные")
        verify_languages(args.output, "android-passenger-profile")
        result["checks"].append("Passenger demo renders RU/UZ/KZ controls in native Android")
        click("KZ", "any")
        await_node("Тіл")
        screenshot(args.output, "android-passenger-kk")
        click("RU", "any")
        await_node("Язык")
        result["checks"].append("Native locale switches immediately")
        # Driver is an explicit demo role, not an API driver.
        click("onay-demo-role-driver", "id")
        click("onay-driver-tab-profile", "id")
        await_node("Автомобиль")
        verify_languages(args.output, "android-driver-profile")
        result["checks"].append("Driver demo renders RU/UZ/KZ controls")
        adb("shell", "am", "force-stop", "uz.tezjet.app")
        adb("shell", "monkey", "-p", "uz.tezjet.app", "-c", "android.intent.category.LAUNCHER", "1")
        await_node("Посмотреть без SMS", timeout=65)
        click("Посмотреть без SMS")
        click("onay-tab-profile", "id")
        verify_languages(args.output, "android-cold-restart-profile")
        result["checks"].append("No Metro required on cold restart")
        result["status"] = "passed"
    except Exception as exc:
        result["error"] = repr(exc)
        try:
            screenshot(args.output, "android-failure")
            xml_snapshot(args.output, "android-failure")
            (args.output / "logcat-tail.txt").write_text(adb("logcat", "-d", "-t", "350", timeout=30), encoding="utf-8")
        except Exception as secondary:
            result["diagnosticError"] = repr(secondary)
        raise
    finally:
        (args.output / "android-verification.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
