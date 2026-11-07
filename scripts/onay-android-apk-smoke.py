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



def wait_for_healthy_android(timeout=180):
    """Do not mistake ADB connected for Android boot or PackageManager readiness."""
    last = "No responsive Android device"
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            state = adb("get-state", timeout=10)
            boot = adb("shell", "getprop", "sys.boot_completed", timeout=10).strip()
            if state.strip() == "device" and boot == "1":
                pm = adb("shell", "pm", "path", "android", timeout=15)
                if "package:" not in pm:
                    raise RuntimeError(f"PackageManager unresponsive: {pm!r}")
                adb("shell", "input", "keyevent", "82", timeout=15)
                return {"adb": "device", "sys.boot_completed": "1", "packageManager": "ready", "input": "ready"}
            last = f"adb={state.strip()}, sys.boot_completed={boot}"
        except (RuntimeError, subprocess.TimeoutExpired) as exc:
            last = str(exc)
        time.sleep(3)
    raise RuntimeError(f"ANDROID_EMULATOR_BLOCKER: no healthy ADB/Android after {timeout}s: {last}")


def installed_code():
    pkg = adb("shell", "dumpsys", "package", "uz.tezjet.app", timeout=45)
    match = re.search(r"\bversionCode=(\d+)", pkg)
    if not match:
        raise AssertionError("Installed Android package uz.tezjet.app has no verifiable versionCode")
    return int(match.group(1))


def install_exact(apk, code, out, stage):
    wait_for_healthy_android()
    if not apk.is_file():
        raise RuntimeError(f"Published APK missing: {apk}")
    response = adb("install", "-r", str(apk.resolve()), timeout=180)
    if "Success" not in response:
        raise RuntimeError(f"{stage} adb install failed: {response}")
    device_code = installed_code()
    if device_code != code:
        raise AssertionError(f"{stage}: device has versionCode={device_code}, expected={code}")
    (out / (stage + "-installed.json")).write_text(json.dumps({
        "apk": apk.name, "package": "uz.tezjet.app", "versionCode": device_code
    }, indent=2))
    return device_code


def open_demo():
    adb("shell", "am", "force-stop", "uz.tezjet.app")
    adb("shell", "monkey", "-p", "uz.tezjet.app", "-c", "android.intent.category.LAUNCHER", "1", timeout=40)
    await_node("Посмотреть без SMS", timeout=90)
    click("Посмотреть без SMS")
    await_node("ДЕМО ONAY", timeout=60)


def native_profile(out, stage):
    open_demo()
    click("onay-tab-profile", "id")
    await_node("Личные данные")
    screenshot(out, stage + "-passenger")
    xml_snapshot(out, stage + "-passenger")
    for caption in ("RU", "UZ", "KZ"):
        await_node(caption)
    click("KZ")
    await_node("Тіл")
    screenshot(out, stage + "-passenger-kz")
    click("RU")
    await_node("Язык")
    click("onay-demo-role-driver", "id")
    click("onay-driver-tab-profile", "id")
    await_node("Автомобиль")
    screenshot(out, stage + "-driver")
    xml_snapshot(out, stage + "-driver")
    for caption in ("RU", "UZ", "KZ"):
        await_node(caption)


def stage_check(out, stage, results):
    try:
        native_profile(out, stage)
        results["checks"].append(stage + ": native passenger and driver RU/UZ/KZ controls visible")
    except Exception as exc:
        results["failures"].append(stage + ": " + repr(exc))
        try:
            screenshot(out, stage + "-failure")
            xml_snapshot(out, stage + "-failure")
        except Exception as secondary:
            results["failures"].append(stage + " diagnostic capture: " + repr(secondary))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--version-code", type=int, required=True)
    parser.add_argument("--upgrade-apk", type=Path, required=True)
    parser.add_argument("--upgrade-version-code", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    output = args.output
    results = {"status": "failed", "checks": [], "failures": [], "boot": None,
               "apk113": args.apk.name, "apk114": args.upgrade_apk.name}
    try:
        results["boot"] = wait_for_healthy_android()
        results["checks"].append("ADB device; sys.boot_completed=1; PackageManager/input responsive")
        install_exact(args.apk, args.version_code, output, "apk113")
        results["checks"].append("APK113 installed, versionCode verified by Android PackageManager")
        stage_check(output, "apk113", results)
        # No uninstall or pm clear: upgrade the same installed application in place.
        install_exact(args.upgrade_apk, args.upgrade_version_code, output, "apk114")
        results["checks"].append("APK113 -> APK114 in-place update; versionCode verified by ADB")
        stage_check(output, "apk114", results)
        if not any(item.startswith("apk114:") for item in results["failures"]):
            stage_check(output, "apk114-cold-restart", results)
        results["status"] = "passed" if not results["failures"] else "failed"
    except Exception as exc:
        results["failures"].append("BLOCKER: " + repr(exc))
        try:
            screenshot(output, "android-blocker")
        except Exception:
            pass
    finally:
        try:
            (output / "adb-devices.txt").write_text(adb("devices", "-l", timeout=15))
            (output / "logcat-tail.txt").write_text(adb("logcat", "-d", "-t", "350", timeout=25))
        except Exception as exc:
            results["failures"].append("ADB diagnostics not available: " + repr(exc))
        (output / "android-verification.json").write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps(results, indent=2, ensure_ascii=False))
    if results["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
