#!/usr/bin/env python3
"""Install stable Linux x64 emulator from verified official SDK metadata.

Do not reuse sdkmanager's incomplete archive cache. Every attempt downloads to a
fresh temporary file and verifies size, published checksum and ZIP CRC before
touching an installed emulator. TLS certificate verification stays enabled.
"""
import argparse
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import ssl
import stat
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

BASE = "https://dl.google.com/android/repository/"
METADATA = BASE + "repository2-3.xml"
MAX_ARCHIVE = 1024 ** 3
MAX_EXPANDED = 3 * 1024 ** 3


def official_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or parsed.netloc != "dl.google.com"
            or not re.fullmatch(r"/android/repository/[A-Za-z0-9_.-]+", parsed.path)
            or parsed.query or parsed.fragment):
        raise ValueError("Only official Android repository HTTPS URLs are allowed")
    return url


class OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        official_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def secure_opener():
    return urllib.request.build_opener(
        OfficialRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))


def download(url, destination, *, size=None, checksum=None, validate=None,
             limit=MAX_ARCHIVE, opener=None, sleep=time.sleep, attempts=3):
    """Bounded retries; failed/truncated/non-ZIP downloads are never committed."""
    official_url(url)
    opener = opener or secure_opener()
    for attempt in range(1, attempts + 1):
        partial = destination.with_suffix(destination.suffix + ".partial")
        try:
            with opener.open(url, timeout=60) as response, partial.open("wb") as output:
                official_url(response.geturl())
                length = response.headers.get("Content-Length")
                if length is not None and (int(length) > limit or
                        (size is not None and int(length) != size)):
                    raise ValueError("HTTP content length differs from expected archive size")
                digest = hashlib.new(checksum[0]) if checksum else None
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > limit or (size is not None and total > size):
                        raise ValueError("Download exceeds expected size")
                    output.write(chunk)
                    if digest:
                        digest.update(chunk)
                if not total or (size is not None and total != size):
                    raise ValueError("Download is empty or truncated")
                if length is not None and total != int(length):
                    raise ValueError("HTTP response is truncated")
                if digest and digest.hexdigest() != checksum[1]:
                    raise ValueError("Official archive checksum mismatch")
            if validate:
                validate(partial)
            partial.replace(destination)
            return attempt
        except (OSError, ValueError, http.client.HTTPException, zipfile.BadZipFile) as error:
            # TLS failures and permanent HTTP errors are not transient retries.
            permanent = (isinstance(error, ssl.SSLError)
                         or isinstance(getattr(error, "reason", None), ssl.SSLError)
                         or isinstance(error, urllib.error.HTTPError)
                         and error.code not in (408, 429) and error.code < 500)
            if permanent or attempt == attempts:
                raise RuntimeError(f"SDK download failed after {attempt} attempt(s): {error}") from error
            print(f"SDK download attempt {attempt} rejected ({error}); retrying fresh", flush=True)
            sleep(2 ** attempt)
        finally:
            partial.unlink(missing_ok=True)


def select_archive(raw):
    if b"<!DOCTYPE" in raw or b"<!ENTITY" in raw:
        raise ValueError("Unexpected XML entity declaration")
    root = ET.fromstring(raw)
    candidates = []
    for package in root.findall("remotePackage"):
        channel = package.find("channelRef")
        if (package.get("path") != "emulator"
                or channel is None or channel.get("ref") != "channel-0"):
            continue
        revision = tuple(int(package.findtext(f"revision/{key}", "0"))
                         for key in ("major", "minor", "micro"))
        for archive in package.findall("archives/archive"):
            if (archive.findtext("host-os") != "linux"
                    or archive.findtext("host-arch") not in (None, "x64")):
                continue
            size = int(archive.findtext("complete/size", "0"))
            digest = archive.find("complete/checksum")
            algorithm = digest.get("type") if digest is not None else None
            checksum = (digest.text or "").strip().lower() if digest is not None else ""
            if (algorithm not in ("sha1", "sha256")
                    or not re.fullmatch(r"[0-9a-f]{%d}" % (40 if algorithm == "sha1" else 64), checksum)
                    or not 0 < size <= MAX_ARCHIVE):
                raise ValueError("Missing or invalid official archive size/checksum")
            url = official_url(urllib.parse.urljoin(BASE, archive.findtext("complete/url", "")))
            candidates.append((revision, package, url, size, (algorithm, checksum)))
    if not candidates:
        raise ValueError("Stable Linux x64 emulator archive not found")
    return root, max(candidates, key=lambda item: item[0])


def validate_zip(path):
    with zipfile.ZipFile(path) as archive:
        total = 0
        names = set()
        for entry in archive.infolist():
            name = PurePosixPath(entry.filename)
            mode = entry.external_attr >> 16
            if (name.is_absolute() or ".." in name.parts or "\\" in entry.filename
                    or not name.parts or name.parts[0] != "emulator"
                    or stat.S_ISLNK(mode) or entry.filename in names):
                raise ValueError("Unsafe emulator ZIP member")
            names.add(entry.filename)
            total += entry.file_size
            if total > MAX_EXPANDED:
                raise ValueError("Emulator ZIP expands beyond size limit")
        bad = archive.testzip()
        if bad:
            raise ValueError(f"Emulator ZIP CRC mismatch: {bad}")
        for required in ("emulator/emulator", "emulator/qemu/linux-x86_64/qemu-system-x86_64",
                         "emulator/source.properties"):
            if required not in archive.namelist():
                raise ValueError(f"Emulator ZIP missing {required}")


def install_archive(archive, sdk_root, root, package, revision):
    """Stage fully before replacing emulator; preserve other SDK packages."""
    validate_zip(archive)
    target = sdk_root / "emulator"
    if target.is_symlink():
        raise ValueError("Refusing symlink emulator installation")
    with tempfile.TemporaryDirectory(prefix=".onay-emulator-", dir=sdk_root) as temp:
        stage = Path(temp)
        with zipfile.ZipFile(archive) as z:
            z.extractall(stage)
            for entry in z.infolist():
                if not entry.is_dir():
                    (stage / entry.filename).chmod((entry.external_attr >> 16) & 0o777 or 0o644)
        installed = stage / "emulator"
        properties = (installed / "source.properties").read_text()
        version = ".".join(map(str, revision))
        if not re.search(r"(?m)^Pkg.Revision\s*=\s*" + re.escape(version) + r"\s*$", properties):
            raise ValueError("Archive revision differs from official metadata")
        for binary in (installed / "emulator", installed / "qemu/linux-x86_64/qemu-system-x86_64"):
            if not os.access(binary, os.X_OK):
                raise ValueError("Emulator ZIP executable permissions missing")
        # sdkmanager (also invoked by emulator-runner) must recognize the verified
        # current version rather than downloading the same damaged cached ZIP.
        repo = ET.Element("ns2:repository", {
            "xmlns:ns2": "http://schemas.android.com/repository/android/common/02",
            "xmlns:generic": "http://schemas.android.com/repository/android/generic/02"})
        for license in root.findall("license"):
            repo.append(copy.deepcopy(license))
        local = copy.deepcopy(package)
        local.tag = "localPackage"
        # ElementTree does not preserve namespace declarations referenced only
        # inside QName attribute values. Normalize the official generic package
        # type to the explicit generic namespace declared on this receipt.
        details = local.find("type-details")
        if details is not None:
            details.set("{http://www.w3.org/2001/XMLSchema-instance}type",
                        "generic:genericDetailsType")
        for child in list(local):
            if child.tag in ("archives", "channelRef"):
                local.remove(child)
        repo.append(local)
        ET.ElementTree(repo).write(installed / "package.xml", encoding="utf-8", xml_declaration=True)
        backup = stage / "previous-emulator"
        if target.exists():
            target.rename(backup)
        try:
            installed.rename(target)
        except OSError:
            if backup.exists():
                backup.rename(target)
            raise


def provision(sdk_root, receipt, *, opener=None, sleep=time.sleep):
    sdk_root.mkdir(parents=True, exist_ok=True)
    report = {"status": "failed", "metadataUrl": METADATA}
    try:
        with tempfile.TemporaryDirectory(prefix="onay-sdk-") as temp:
            metadata, archive = Path(temp) / "repository.xml", Path(temp) / "emulator.zip"
            download(METADATA, metadata, limit=8 * 1024 ** 2, opener=opener, sleep=sleep)
            raw = metadata.read_bytes()
            root, (revision, package, url, size, checksum) = select_archive(raw)
            report.update(revision=".".join(map(str, revision)), archiveUrl=url,
                          size=size, checksumType=checksum[0], checksum=checksum[1],
                          metadataSha256=hashlib.sha256(raw).hexdigest())
            report["archiveAttempts"] = download(url, archive, size=size, checksum=checksum,
                validate=validate_zip, opener=opener, sleep=sleep)
            install_archive(archive, sdk_root, root, package, revision)
            report["status"] = "passed"
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        receipt.parent.mkdir(parents=True, exist_ok=True)
        receipt.write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-root", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    provision(args.sdk_root, args.receipt)
