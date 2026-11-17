#!/usr/bin/env python3
"""Capture installed Android settings icon and compare package metadata; never claim Samsung testing on emulator."""
import argparse
import importlib.util
import json
import re
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location("onay_adb", Path(__file__).with_name("onay-android-apk-smoke.py"))
if not spec or not spec.loader: raise RuntimeError("ADB helper missing")
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True, type=Path)
parser.add_argument("--version-code", type=int, default=119)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
package = "uz.tezjet.app"
report = {"status": "failed", "package": package, "versionCode": args.version_code, "checks": []}
try:
    result = h.adb("shell", "dumpsys", "package", package)
    if not re.search(r"versionCode="+str(args.version_code)+r"\b", result):
        raise AssertionError("Installed APK versionCode differs from expected")
    report["checks"].append("Installed Android package/versionCode inspected with dumpsys")
    h.adb("shell", "am", "start", "-a", "android.settings.APPLICATION_DETAILS_SETTINGS", "-d", "package:" + package)
    time.sleep(1.2)  # QA screenshot settle only; not an app startup delay.
    h.screenshot(args.output, "onay-installed-app-info-icon")
    h.xml_snapshot(args.output, "onay-installed-app-info-icon")
    report["checks"].append("Captured actual Android Settings app info screen containing installed launcher art")
    report["checks"].append("Samsung physical launcher/round mask still requires Samsung-device evidence")
    report["status"] = "passed"
finally:
    (args.output / "launcher-qa.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
