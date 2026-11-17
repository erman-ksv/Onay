#!/usr/bin/env python3
"""Native Android acceptance: existing APK116 upgraded in-place to APK117; About in RU/UZ/KZ and light/dark.
Offline demo only. No API, SMS, user account changes, or Metro.
"""
import argparse
import importlib.util
import json
import re
import time
from pathlib import Path

helper_path = Path(__file__).with_name("onay-android-apk-smoke.py")
spec = importlib.util.spec_from_file_location("onay_apk_helpers", helper_path)
if spec is None or spec.loader is None:
    raise RuntimeError("Android ADB helper unavailable")
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)

HEADINGS = {"ru": "О приложении", "uz": "Ilova haqida", "kk": "Қолданба туралы"}
LEGAL = {
    "ru": ("Политика конфиденциальности", "Условия использования", "Документ не опубликован"),
    "uz": ("Maxfiylik siyosati", "Foydalanish shartlari", "Hujjat eʼlon qilinmagan"),
    "kk": ("Құпиялылық саясаты", "Пайдалану шарттары", "Құжат жарияланбаған"),
}

def record(output, name):
    h.screenshot(output, name)
    h.xml_snapshot(output, name)

def swipe_up():
    h.adb("shell", "input", "swipe", "510", "1540", "510", "520", "390")
    time.sleep(0.8)

def swipe_down():
    h.adb("shell", "input", "swipe", "510", "560", "510", "1510", "390")
    time.sleep(0.8)

def click_visible(test_id, direction="up"):
    for _ in range(6):
        root, _ = h.ui_tree()
        node = h.find_node(root, test_id, "id")
        if node is not None:
            x, y = h.bounds(node)
            if 60 <= x <= 1020 and 120 <= y <= 1750:
                h.adb("shell", "input", "tap", str(x), str(y))
                time.sleep(0.8)
                return
        (swipe_up if direction == "up" else swipe_down)()
    raise AssertionError(f"Visible clickable Android element not found: {test_id}")

def node_text(node):
    return " ".join(
        item for child in node.iter() for item in
        (child.attrib.get("text", ""), child.attrib.get("content-desc", ""))
        if item
    )

def assert_legal_feedback(lang, index):
    expected_label, expected_status = LEGAL[lang][index], LEGAL[lang][2]
    node = h.await_node("onay-about-legal-feedback", "id")
    actual = node_text(node)
    if expected_label not in actual or expected_status not in actual:
        raise AssertionError(f"Wrong legal feedback for {lang}: {actual!r}; expected {expected_label!r} and {expected_status!r}")

def open_about(lang):
    h.click("onay-profile-about", "id")
    h.await_node("onay-passenger-about-screen", "id")
    h.await_node("onay-about-back", "id")
    h.await_node(HEADINGS[lang], "text")
    h.await_node("onay-about-confirmed-logo", "id")
    back = h.await_node("onay-about-back", "id")
    top = int(re.findall(r"\d+", back.attrib.get("bounds", "[0,0][0,0]"))[1])
    if top < 35:
        raise AssertionError(f"About header intrudes into system status bar: y={top}")

def verify_about(output, lang, theme, checks):
    h.click("onay-profile-theme-" + theme, "id")
    selected_theme = h.await_node("onay-profile-theme-" + theme, "id")
    if selected_theme.attrib.get("selected") != "true":
        raise AssertionError(f"Theme {theme} not selected: {selected_theme.attrib}")
    h.click("onay-language-" + lang, "id")
    h.await_node({"ru": "Язык", "uz": "Til", "kk": "Тіл"}[lang])
    open_about(lang)
    base = f"about-{lang}-{theme}"
    record(output, base + "-top")
    swipe_up()
    h.await_node("All rights reserved")
    record(output, base + "-bottom")
    for index, test_id in enumerate(("onay-legal-privacy-unavailable", "onay-legal-terms-unavailable")):
        click_visible(test_id, "down")
        assert_legal_feedback(lang, index)
        record(output, base + ("-privacy" if index == 0 else "-terms"))
    if lang == "kk" and theme == "light":
        # Exercise physical Android system Back from a modal, not app-wide logout.
        h.adb("shell", "input", "keyevent", "4")
        checks.append("Android system Back from About returns to passenger profile")
    else:
        click_visible("onay-about-back", "down")
        checks.append(f"About screen Back returns to passenger profile ({lang}, {theme})")
    h.await_node("onay-passenger-profile-panel", "id")
    root, _ = h.ui_tree()
    if h.find_node(root, "onay-passenger-about-screen", "id") is not None:
        raise AssertionError("About screen still present after Back")
    record(output, base + "-returned")
    checks.append(f"About {lang}/{theme}: real Android top, scroll-to-footer, privacy, terms and Back")

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--old-apk", type=Path, required=True)
    p.add_argument("--new-apk", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {"status": "failed", "checks": [], "failures": [], "oldVersion": 116, "newVersion": 117}
    try:
        h.wait_for_healthy_android()
        h.install_exact(args.old_apk, 116, args.output, "apk116")
        h.open_demo()
        h.click("onay-tab-profile", "id")
        h.await_node("onay-passenger-profile-panel", "id")
        h.click("onay-profile-about", "id")
        h.await_node("onay-passenger-about-screen", "id")
        record(args.output, "apk116-before-upgrade-about")
        report["checks"].append("APK116 installed, baseline About screen captured")
        # No uninstall or clearing any app storage; upgrade keeps the signing identity.
        h.install_exact(args.new_apk, 117, args.output, "apk117")
        report["checks"].append("ADB in-place APK116 → APK117 upgrade; Android PackageManager versionCode=117")
        h.open_demo()
        h.click("onay-tab-profile", "id")
        h.await_node("onay-passenger-profile-panel", "id")
        for theme in ("dark", "light"):
            for lang in ("ru", "uz", "kk"):
                verify_about(args.output, lang, theme, report["checks"])
        report["status"] = "passed"
    except Exception as exc:
        report["failures"].append(repr(exc))
        try:
            record(args.output, "android-apk117-failure")
        except Exception as capture_exc:
            report["failures"].append("Screenshot failure: " + repr(capture_exc))
    finally:
        (args.output / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if report["status"] != "passed":
        raise SystemExit(1)

if __name__ == "__main__":
    main()
