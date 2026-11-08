#!/usr/bin/env python3
"""Verify the *compiled* Android adaptive launcher chain, not original ZIP filenames.

aapt2 reads the real binary XML and resources.arsc inside the APK. The resource
IDs in adaptive XML are resolved to resource-table values and then to packaged
PNG/WebP images; a renamed/compressed file is accepted, a missing reference is not.
Failures preserve aapt2 dumps, a JSON diagnostic receipt and the original APK
(uploaded by an always() step in the caller's workflow).
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path

ENTRY = re.compile(r"(?im)^\s*resource\s+(0x[0-9a-f]{8})\s+([^\r\n]+)")
IMAGE = re.compile(r"res/[^\s'\"\]\),;]+\.(?:png|webp|avif)\b", re.I)
XML = re.compile(r"res/[^\s'\"\]\),;]+\.xml\b", re.I)
REFERENCE = re.compile(r"@(?:0x)?([0-9a-f]{8})\b", re.I)
WHITE = re.compile(r"(?:#f{6,8}\b|0xffffffff\b)", re.I)
PACKAGE = "uz.tezjet.app"

def aapt2_path():
    found = shutil.which("aapt2")
    if found:
        return found
    sdk = os.getenv("ANDROID_HOME") or os.getenv("ANDROID_SDK_ROOT")
    if not sdk:
        raise AssertionError("Android SDK missing: cannot validate compiled resources")
    variants = sorted((Path(sdk) / "build-tools").glob("*/aapt2"), reverse=True)
    if not variants:
        raise AssertionError("aapt2 missing from Android SDK build-tools")
    return str(variants[0])

def dump(tool, apk, command, *opts):
    result = subprocess.run([tool, "dump", command, str(apk), *opts],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, check=False, timeout=120)
    if result.returncode:
        raise AssertionError(f"aapt2 dump {command} failed: {result.stderr[-2500:]}")
    return result.stdout

def table_entries(table):
    items = list(ENTRY.finditer(table))
    result = {}
    for i, match in enumerate(items):
        key = match.group(1).lower()
        body = table[match.end():items[i + 1].start() if i + 1 < len(items) else len(table)]
        if key in result:
            result[key]["body"] += "\n" + body
        else:
            result[key] = {"name": match.group(2).strip(), "body": body}
    return result

def image_paths(data):
    return sorted(set(IMAGE.findall(data)))

def confirm_image(z, value, label):
    paths = image_paths(value)
    if not paths:
        raise AssertionError(f"{label} reference does not resolve to packaged raster image; resource value: {value[:600]}")
    for path in paths:
        if path not in z.namelist():
            raise AssertionError(f"{label} linked raster missing from APK ZIP: {path}")
        raw = z.read(path)[:16]
        if not (raw.startswith(bytes.fromhex("89504e470d0a1a0a")) or
                (raw.startswith(b"RIFF") and raw[8:12] == b"WEBP") or
                b"ftypavif" in raw or b"ftypavis" in raw):
            raise AssertionError(f"{label} packaged image has unsupported/invalid magic: {path}")
    return paths

def resource_id(xml, element):
    # aapt2's compiled XML has an E: foreground/background line followed by an
    # A: android:drawable(...) reference. Never accept mere keyword presence.
    m = re.search(r"(?ims)^\s*E:\s*(?:[^\s:]+:)?"+re.escape(element)+r"\b([^\r\n]*)(.*?)(?=^\s*E:|\Z)", xml)
    if not m:
        raise AssertionError(f"Compiled adaptive icon has no <{element}> element")
    a = re.search(r"(?im)^\s*A:\s*(?:android:)?drawable[^\r\n]*?@(?:0x)?([0-9a-f]{8})\b", m.group(2))
    if not a:
        raise AssertionError(f"Compiled <{element}> has no Android drawable resource ID: {m.group(2)[:300]}")
    return "0x" + a.group(1).lower()

def resolve(entries, identifier):
    if identifier not in entries:
        raise AssertionError(f"Resource ID {identifier} in compiled XML not present in resources.arsc")
    # Follow resource-to-resource aliases, but do not fall back to names.
    visited = set()
    record = entries[identifier]
    while record and not (image_paths(record["body"]) or WHITE.search(record["body"])):
        if identifier in visited:
            raise AssertionError("Resource alias loop")
        visited.add(identifier)
        match = REFERENCE.search(record["body"])
        if not match:
            break
        identifier = "0x" + match.group(1).lower()
        record = entries.get(identifier)
    if record is None:
        raise AssertionError(f"Broken resource alias {identifier}")
    return {"id": identifier, "name": record["name"], "body": record["body"]}

def run(apk, output):
    output.mkdir(parents=True, exist_ok=True)
    tool = aapt2_path()
    info = {"status": "failed", "apk": apk.name,
            "sha256": hashlib.sha256(apk.read_bytes()).hexdigest(),
            "aapt2": tool, "checks": []}
    try:
        if not zipfile.is_zipfile(apk):
            raise AssertionError("APK is not a valid archive")
        resource_dump = dump(tool, apk, "resources", "-v")
        (output / "resources-aapt2.txt").write_text(resource_dump)
        badging = dump(tool, apk, "badging")
        (output / "badging-aapt2.txt").write_text(badging)
        if "package: name='"+PACKAGE+"'" not in badging:
            raise AssertionError("Packaged applicationId does not match "+PACKAGE)
        info["checks"].append("aapt2 badging confirms package uz.tezjet.app")
        entries = table_entries(resource_dump)
        if not entries:
            raise AssertionError("No compiled resource records in aapt2 resource dump")
        with zipfile.ZipFile(apk) as z:
            names = z.namelist()
            launcher = [r for r in entries.values()
                        if re.search(r"(?:^|:)mipmap/ic_launcher(?:\s|$)", r["name"])]
            if not launcher:
                raise AssertionError("Missing actual mipmap/ic_launcher resource in resources.arsc")
            launcher_data = "\n".join(r["body"] for r in launcher)
            xml_files = sorted(set(XML.findall(launcher_data)))
            # Resolve compiled adaptive XML via the mipmap resource table.
            adaptive = [p for p in xml_files if "anydpi" in p and p.endswith(".xml")]
            if not adaptive:
                adaptive = [p for p in xml_files if p.endswith(".xml")]
            if not adaptive:
                raise AssertionError("No adaptive XML linked from mipmap/ic_launcher in resources.arsc")
            icon_xml = adaptive[0]
            if icon_xml not in names:
                raise AssertionError("Compiled launcher XML reference missing from APK: "+icon_xml)
            tree = dump(tool, apk, "xmltree", "--file", icon_xml)
            (output / "adaptive-icon-xmltree.txt").write_text(tree)
            if not re.search(r"(?m)^\s*E:\s*adaptive-icon\b", tree):
                raise AssertionError("Compiled icon XML is not an adaptive-icon")
            foreground_id = resource_id(tree, "foreground")
            background_id = resource_id(tree, "background")
            fg = resolve(entries, foreground_id)
            bg = resolve(entries, background_id)
            files = confirm_image(z, fg["body"], "adaptive foreground")
            info["foreground"] = {"id": foreground_id, "resource": fg["name"], "packed_files": files}
            info["checks"].append("foreground XML ID resolves to an existing, valid packaged PNG/WebP")
            # Background may be a color resource instead of a bitmap.
            if WHITE.search(bg["body"]):
                info["background"] = {"id": background_id, "resource": bg["name"], "value": "white"}
            else:
                raise AssertionError("Adaptive background resource isn't verified white: "+bg["body"][:400])
            info["checks"].append("background XML ID resolves to opaque white in resources.arsc")
            # Regular launcher: inspect Android badging-mapped density resources.
            icons = re.findall(r"(?m)^application-icon(?:-\d+)?:\s*'([^']+)'", badging)
            raster = [p for p in icons if IMAGE.fullmatch(p)]
            if not raster:
                raster = image_paths(launcher_data)
            if not raster:
                raise AssertionError("No conventional launcher raster resolved by aapt2")
            for path in raster:
                confirm_image(z, path, "regular launcher")
            info["regular_icons"] = raster
            info["checks"].append("regular launcher raster resolves through aapt2 to actual packaged images")
            bundle = z.read("assets/index.android.bundle")
            if not bundle.startswith(bytes.fromhex("c61fbc03")):
                raise AssertionError("Standalone Hermes bytecode missing from APK")
            for marker in (b"onay-startup-screen", b"onay-startup-squares",
                           b"onay-startup-label", b"onay-about-source-sha"):
                if marker not in bundle:
                    raise AssertionError(f"Missing startup/About marker {marker!r}")
            info["checks"].append("Hermes bundle contains startup squares, label and build identity")
        info["adaptive_xml"] = icon_xml
        info["status"] = "passed"
    except Exception as exc:
        info["failure"] = repr(exc)
    finally:
        (output / "apk119-resource-verification.json").write_text(
            json.dumps(info, ensure_ascii=False, indent=2)+"\n")
        print(json.dumps(info, ensure_ascii=False, indent=2), flush=True)
    if info["status"] != "passed":
        raise SystemExit(1)

if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--apk", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args=parser.parse_args()
    run(args.apk, args.output)
