"""Offline behavioral regressions for Android SDK download and installation."""
import hashlib
import http.client
import importlib.util
import io
import json
from pathlib import Path
import ssl
import tempfile
import unittest
import urllib.error
import xml.etree.ElementTree as ET
import zipfile

spec = importlib.util.spec_from_file_location(
    "provision_android_emulator", Path(__file__).with_name("provision-android-emulator.py"))
sdk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sdk)


def archive_bytes(extra=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        entries = {
            "emulator/emulator": b"executable-emulator-fixture",
            "emulator/qemu/linux-x86_64/qemu-system-x86_64": b"qemu-fixture",
            "emulator/source.properties": b"Pkg.Revision=37.2.13\n",
            **(extra or {}),
        }
        for name, data in entries.items():
            entry = zipfile.ZipInfo(name)
            entry.external_attr = 0o100755 << 16
            archive.writestr(entry, data)
    return output.getvalue()


def metadata(data, *, url="emulator-linux_x64-fixture.zip", revision="37", channel="channel-0"):
    checksum = hashlib.sha1(data).hexdigest()
    return f'''<sdk-repository xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <license id="android-sdk-license" type="text">license fixture</license>
    <remotePackage path="emulator"><type-details xsi:type="generic:genericDetailsType"/>
    <revision><major>{revision}</major><minor>2</minor><micro>13</micro></revision>
    <display-name>Android Emulator</display-name><uses-license ref="android-sdk-license"/>
    <channelRef ref="{channel}"/><archives><archive><host-os>linux</host-os><host-arch>x64</host-arch>
    <complete><size>{len(data)}</size><checksum type="sha1">{checksum}</checksum>
    <url>{url}</url></complete></archive></archives></remotePackage></sdk-repository>'''.encode()


class Response(io.BytesIO):
    def __init__(self, data, url=sdk.BASE + "emulator-linux_x64-fixture.zip", length=None):
        super().__init__(data)
        self.url = url
        self.headers = {"Content-Length": str(len(data) if length is None else length)}

    def geturl(self):
        return self.url


class Transport:
    def __init__(self, *events):
        self.events = list(events)
        self.calls = []

    def open(self, url, timeout):
        self.calls.append((url, timeout))
        event = self.events.pop(0)
        if isinstance(event, BaseException):
            raise event
        return event


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = archive_bytes()

    def provision(self, *responses):
        transport = Transport(Response(metadata(self.archive), sdk.METADATA), *responses)
        report = sdk.provision(self.root / "sdk", self.root / "receipt.json",
                               opener=transport, sleep=lambda _: None)
        return report, transport

    def download(self, transport, **kwargs):
        return sdk.download(sdk.BASE + "emulator-linux_x64-fixture.zip", self.root / "download.zip",
                            opener=transport, sleep=lambda _: None, **kwargs)

    def test_success_installs_verified_binaries_and_sdkmanager_metadata(self):
        report, transport = self.provision(Response(self.archive))
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["archiveAttempts"], 1)
        installed = self.root / "sdk/emulator"
        self.assertEqual((installed / "emulator").read_bytes(), b"executable-emulator-fixture")
        self.assertTrue((installed / "emulator").stat().st_mode & 0o111)
        local = ET.parse(installed / "package.xml").getroot().find("localPackage")
        self.assertEqual(local.get("path"), "emulator")
        self.assertEqual(local.findtext("revision/major"), "37")
        self.assertIsNone(local.find("archives"))
        self.assertEqual(len(transport.calls), 2)

    def test_html_error_body_retries_fresh_and_recovers(self):
        report, transport = self.provision(Response(b"<html>gateway error</html>"), Response(self.archive))
        self.assertEqual(report["archiveAttempts"], 2)
        self.assertEqual(len(transport.calls), 3)
        self.assertFalse((self.root / "download.zip.partial").exists())

    def test_truncated_content_retries_and_never_installs_on_exhaustion(self):
        sdkroot = self.root / "sdk"
        previous = sdkroot / "emulator/previous"
        previous.parent.mkdir(parents=True)
        previous.write_text("preserve")
        transport = Transport(Response(metadata(self.archive), sdk.METADATA), *[
            Response(self.archive[:60], length=len(self.archive)) for _ in range(3)])
        with self.assertRaisesRegex(RuntimeError, "after 3 attempt"):
            sdk.provision(sdkroot, self.root / "receipt.json", opener=transport, sleep=lambda _: None)
        self.assertEqual(previous.read_text(), "preserve")
        self.assertEqual(json.loads((self.root / "receipt.json").read_text())["status"], "failed")
        self.assertEqual(len(transport.calls), 4)

    def test_checksum_mismatch_cannot_replace_an_existing_download(self):
        destination = self.root / "download.zip"
        destination.write_bytes(b"previous verified archive")
        transport = Transport(*[Response(self.archive) for _ in range(3)])
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            self.download(transport, size=len(self.archive), checksum=("sha1", "0" * 40))
        self.assertEqual(destination.read_bytes(), b"previous verified archive")
        self.assertFalse(destination.with_suffix(".zip.partial").exists())

    def test_non_zip_body_is_rejected_even_with_matching_size_and_checksum(self):
        body = b"<html>not an emulator archive</html>"
        with self.assertRaisesRegex(RuntimeError, "not a zip file"):
            self.download(Transport(*[Response(body) for _ in range(3)]),
                size=len(body), checksum=("sha1", hashlib.sha1(body).hexdigest()), validate=sdk.validate_zip)
        self.assertFalse((self.root / "download.zip").exists())

    def test_download_without_length_header_still_enforces_metadata_size(self):
        response = Response(self.archive)
        response.headers.clear()
        self.assertEqual(self.download(Transport(response), size=len(self.archive),
            checksum=("sha1", hashlib.sha1(self.archive).hexdigest()), validate=sdk.validate_zip), 1)

    def test_oversized_download_is_rejected_without_committing_bytes(self):
        with self.assertRaisesRegex(RuntimeError, "content length"):
            self.download(Transport(*[Response(self.archive) for _ in range(3)]), limit=10)
        self.assertFalse((self.root / "download.zip").exists())

    def test_truncated_zip_is_rejected_even_if_checksum_matches(self):
        broken = self.archive[:-40]
        with self.assertRaises(RuntimeError):
            self.download(Transport(*[Response(broken) for _ in range(3)]),
                size=len(broken), checksum=("sha1", hashlib.sha1(broken).hexdigest()), validate=sdk.validate_zip)
        self.assertFalse((self.root / "download.zip").exists())

    def test_crc_corruption_is_rejected_even_if_outer_checksum_matches(self):
        broken = self.archive.replace(b"executable-emulator-fixture", b"Xxecutable-emulator-fixture")
        with self.assertRaisesRegex(RuntimeError, "CRC"):
            self.download(Transport(*[Response(broken) for _ in range(3)]),
                size=len(broken), checksum=("sha1", hashlib.sha1(broken).hexdigest()), validate=sdk.validate_zip)

    def test_transient_http_error_recovers_but_permanent_403_does_not_retry(self):
        for code, attempts in ((503, 2), (403, 1)):
            with self.subTest(code=code):
                error = urllib.error.HTTPError(sdk.METADATA, code, "fixture", {}, None)
                transport = Transport(error, Response(self.archive))
                if code == 403:
                    with self.assertRaises(RuntimeError):
                        self.download(transport)
                else:
                    self.download(transport)
                self.assertEqual(len(transport.calls), attempts)

    def test_tls_verification_failure_is_not_retried_or_downgraded(self):
        transport = Transport(urllib.error.URLError(ssl.SSLCertVerificationError("invalid certificate")))
        with self.assertRaisesRegex(RuntimeError, "certificate"):
            self.download(transport)
        self.assertEqual(len(transport.calls), 1)
        context = next(handler._context for handler in sdk.secure_opener().handlers
                       if hasattr(handler, "_context"))
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_incomplete_http_read_is_bounded(self):
        transport = Transport(*[http.client.IncompleteRead(b"partial", 100) for _ in range(3)])
        with self.assertRaisesRegex(RuntimeError, "after 3 attempt"):
            self.download(transport)
        self.assertEqual(len(transport.calls), 3)

    def test_untrusted_url_and_redirect_are_rejected_before_reading(self):
        for url in ("http://dl.google.com/android/repository/emulator.zip",
                    "https://evil.invalid/emulator.zip", sdk.BASE + "../emulator.zip",
                    "https://dl.google.com@evil.invalid/android/repository/e.zip"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                sdk.official_url(url)
        transport = Transport(*[Response(self.archive, "https://evil.invalid/e.zip") for _ in range(3)])
        with self.assertRaises(RuntimeError):
            self.download(transport)
        redirect = sdk.OfficialRedirect()
        with self.assertRaises(ValueError):
            redirect.redirect_request(None, None, 302, "found", {}, "http://dl.google.com/android/repository/e.zip")

    def test_stable_channel_required_and_metadata_checksum_cannot_be_omitted(self):
        for raw in (metadata(self.archive, channel="channel-1"),
                    metadata(self.archive).replace(b'<checksum type="sha1">', b'<checksum type="md5">'),
                    metadata(self.archive, url="https://evil.invalid/e.zip")):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                sdk.select_archive(raw)

    def test_zip_path_traversal_and_symlink_are_rejected(self):
        path = self.root / "unsafe.zip"
        for member in ("../escape", "/emulator/escape", "emulator/../escape", "emulator\\escape"):
            path.write_bytes(archive_bytes({member: b"unsafe"}))
            with self.subTest(member=member), self.assertRaises(ValueError):
                sdk.validate_zip(path)
        path.write_bytes(self.archive)
        with zipfile.ZipFile(path, "a") as z:
            entry = zipfile.ZipInfo("emulator/link")
            entry.external_attr = 0o120777 << 16
            z.writestr(entry, b"/tmp/escape")
        with self.assertRaises(ValueError):
            sdk.validate_zip(path)

    def test_zip_missing_binary_and_expansion_limit_are_rejected(self):
        path = self.root / "incomplete.zip"
        with zipfile.ZipFile(path, "w") as z:
            z.writestr("emulator/source.properties", b"Pkg.Revision=37.2.13")
        with self.assertRaisesRegex(ValueError, "missing"):
            sdk.validate_zip(path)
        path.write_bytes(self.archive)
        previous = sdk.MAX_EXPANDED
        try:
            sdk.MAX_EXPANDED = 1
            with self.assertRaisesRegex(ValueError, "size limit"):
                sdk.validate_zip(path)
        finally:
            sdk.MAX_EXPANDED = previous

    def test_mismatched_archive_revision_preserves_existing_install(self):
        sdkroot = self.root / "sdk"
        previous = sdkroot / "emulator/previous"
        previous.parent.mkdir(parents=True)
        previous.write_text("preserve")
        transport = Transport(Response(metadata(self.archive, revision="38"), sdk.METADATA), Response(self.archive))
        with self.assertRaisesRegex(ValueError, "revision differs"):
            sdk.provision(sdkroot, self.root / "receipt.json", opener=transport, sleep=lambda _: None)
        self.assertEqual(previous.read_text(), "preserve")
        self.assertFalse((sdkroot / "emulator/package.xml").exists())


if __name__ == "__main__":
    unittest.main()
