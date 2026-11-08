#!/usr/bin/env python3
"""Check installed Android build identity against the *same artifact's* build-provenance.json.

Call after installing a newly approved APK on an Android emulator/device.
Never substitute a hardcoded SHA or infer it from the current repository HEAD.
"""
import argparse
import importlib.util
import json
import re
from pathlib import Path

helper_path = Path(__file__).with_name("onay-android-apk-smoke.py")
spec = importlib.util.spec_from_file_location("onay_adb", helper_path)
if spec is None or spec.loader is None:
    raise RuntimeError("Native ADB helper missing")
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provenance", required=True, type=Path)
    parser.add_argument("--version-code", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {"status": "failed", "checks": [], "failures": []}
    try:
        receipt = json.loads(args.provenance.read_text(encoding="utf-8"))
        source_sha = receipt["sourceSha"]
        assert isinstance(source_sha, str) and re.fullmatch(r"[0-9a-f]{40}", source_sha), "Missing valid sourceSha in provenance"
        assert receipt["applicationId"] == "uz.tezjet.app", "Unexpected package"
        assert receipt["versionCode"] == args.version_code, "Provenance version mismatch"
        expected_short = source_sha[:12]
        h.wait_for_healthy_android()
        installed_version = h.installed_code()
        assert installed_version == receipt["versionCode"], (
            f"Installed Android versionCode {installed_version} differs from receipt {receipt['versionCode']}"
        )
        h.open_demo()
        h.click("onay-tab-profile", "id")
        h.click("onay-profile-about", "id")
        node = h.await_node("onay-about-source-sha", "id")
        root, tree_xml = h.ui_tree()
        node = h.find_node(root, "onay-about-source-sha", "id")
        assert node is not None, "Source SHA UI element absent"
        text = " ".join(
            val for child in node.iter() for val in
            (child.attrib.get("text", ""), child.attrib.get("content-desc", ""))
            if val
        )
        assert "недоступен" not in text, f"UI reports unavailable SHA: {text!r}"
        assert expected_short in text, (
            f"Installed About SHA {text!r} differs from artifact build-provenance.json {expected_short!r}"
        )
        assert source_sha[:12] == expected_short
        h.screenshot(args.output, "android-about-build-sha")
        (args.output / "android-about-build-sha.xml").write_text(tree_xml, encoding="utf-8")
        report["checks"].append("Device versionCode equals artifact build-provenance.json")
        report["checks"].append(f"Native About displays source SHA prefix {expected_short} from artifact receipt")
        report["status"] = "passed"
    except Exception as exc:
        report["failures"].append(repr(exc))
        try:
            h.screenshot(args.output, "android-build-sha-failure")
            h.xml_snapshot(args.output, "android-build-sha-failure")
        except Exception as capture_exc:
            report["failures"].append("Failure screenshot: " + repr(capture_exc))
    finally:
        (args.output / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if report["status"] != "passed":
        raise SystemExit(1)

if __name__ == "__main__":
    main()
