#!/usr/bin/env python3
"""Actual exported RN app, local API only; pinned HTML is a separate visual reference."""
import argparse
import base64
import hashlib
import html
import json
import os
from pathlib import Path
import re
import traceback
import uuid
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
from importlib.machinery import SourceFileLoader

helpers = SourceFileLoader("onay_driver_qa", str(Path(__file__).with_name("driver-route-browser-qa.py"))).load_module()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:4174")
    parser.add_argument("--unconfigured-url", default="http://127.0.0.1:4175")
    parser.add_argument("--api-url", default="http://127.0.0.1:5000")
    parser.add_argument("--output-dir", type=Path, default=Path("/tmp/onay-v2-qa"))
    args = parser.parse_args()
    assert os.environ.get("NODE_ENV") in {"test", "development"}
    for origin in (args.base_url, args.unconfigured_url, args.api_url):
        parsed = urlparse(origin)
        assert parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        assert parsed.path in {"", "/"} and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = {"status": "failed", "checks": [], "pageErrors": [],
              "browser": "Python Playwright Chromium; Browser plugin unavailable",
              "limitations": ["Screenshots are web RN renders, not Android screenshots.",
                              "No physical Android Back, keyboard, system bars or GPS validation.",
                              "Screenshots support manual comparison; no pixel-equivalence percentage is inferred.",
                              "Prototype chat, delayed booking and negotiated prices have no implemented production API."]}

    def passed(name):
        report["checks"].append(name)
        print("PASS:", name, flush=True)

    def shot(page, name):
        page.wait_for_timeout(450)
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), name + " overflows"
        page.screenshot(path=str(args.output_dir / (name + ".png")))

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 390, "height": 844}, locale="ru-RU")
            page = context.new_page()
            page.set_default_timeout(20000)
            page.on("pageerror", lambda e: report["pageErrors"].append(helpers.redact(str(e))))
            page.on("dialog", lambda dialog: dialog.accept())
            # Reproduce the APK default: no baked API, token or cached endpoint.
            page.goto(args.unconfigured_url, wait_until="domcontentloaded")
            expect(page.get_by_test_id("onay-auth-original-logo")).to_be_visible()
            expect(page.get_by_test_id("onay-auth-phone")).to_be_visible()
            shot(page, "actual-unconfigured-auth")
            page.get_by_test_id("onay-auth-server-settings").click()
            expect(page.get_by_test_id("onay-server-settings-panel")).to_be_visible()
            page.get_by_test_id("onay-server-url").fill("not-a-url")
            page.get_by_role("button", name="Сохранить сервер", exact=True).click()
            expect(page.get_by_test_id("onay-server-settings-panel")).to_be_visible()
            shot(page, "actual-connection-invalid")
            page.get_by_test_id("onay-screen-back").click()
            expect(page.get_by_test_id("onay-auth-phone")).to_be_visible()
            passed("Fresh unconfigured APK entry uses V2 auth and connection screens; invalid endpoint retains error screen")

            page.goto(args.base_url, wait_until="domcontentloaded")
            for role in ("passenger", "driver"):
                if role == "driver":
                    page.get_by_test_id("onay-auth-role-switch").click()
                page.get_by_test_id("auth-signup-mode").click()
                page.get_by_test_id("registration-given-name").fill("Visual")
                page.get_by_test_id("registration-family-name").fill("QA")
                phone = "+998" + str(uuid.uuid4().int % 1000000000).zfill(9)
                page.get_by_test_id("onay-auth-phone").fill(phone)
                shot(page, "actual-" + role + "-registration")
                with page.expect_response(lambda r: urlparse(r.url).path == "/api/auth/request-otp" and r.request.method == "POST") as pending:
                    page.get_by_test_id("onay-auth-submit").click()
                assert pending.value.status == 202
                code = pending.value.json()["demo_code"]  # local dev only; never report or screenshot code
                otp = page.get_by_test_id("onay-auth-otp")
                expect(otp).to_be_visible()
                expect(page.get_by_test_id("onay-auth-role-switch")).to_have_count(0)
                shot(page, "actual-" + role + "-otp-empty")
                otp.fill(code[:5])
                expect(page.get_by_test_id("onay-auth-submit")).to_be_disabled()
                otp.fill(code)
                with page.expect_response(lambda r: urlparse(r.url).path == "/api/auth/verify-otp" and r.request.method == "POST") as verified:
                    page.get_by_test_id("onay-auth-submit").click()
                assert verified.value.status == 200
                if role == "passenger":
                    expect(page.get_by_test_id("onay-passenger-home")).to_be_visible()
                    expect(page.get_by_test_id("onay-passenger-booking-page")).to_have_count(0)
                    shot(page, "actual-passenger-home")
                    page.get_by_test_id("onay-home-to-city").click()
                    expect(page.get_by_test_id("onay-passenger-booking-page")).to_be_visible()
                    shot(page, "actual-passenger-builder")
                    page.get_by_test_id("onay-screen-back").click()
                    expect(page.get_by_test_id("onay-passenger-home")).to_be_visible()
                    for tab in ("trips", "chats", "profile"):
                        page.get_by_test_id("onay-tab-" + tab).click()
                        shot(page, "actual-passenger-" + tab)
                    page.get_by_test_id("onay-tab-trips").click()
                    page.get_by_test_id("onay-tab-profile").click()
                    page.get_by_test_id("onay-profile-history").click()
                    expect(page.get_by_test_id("passenger-history-empty")).to_be_visible()
                    expect(page.get_by_test_id("passenger-history-toggle")).to_have_count(0)
                    shot(page, "actual-passenger-history")
                    page.get_by_test_id("onay-trips-back-to-active").click()
                    page.get_by_test_id("onay-tab-profile").click()
                    page.get_by_test_id("onay-profile-personal-data").click()
                    expect(page.get_by_test_id("onay-profile-personal-name")).to_have_text("Visual QA")
                    shot(page, "actual-passenger-personal-data")
                    page.get_by_test_id("onay-screen-back").click()
                    for child in ("support", "about"):
                        page.get_by_test_id("onay-profile-" + child).click()
                        expect(page.get_by_test_id("onay-passenger-" + child + "-screen")).to_be_visible()
                        shot(page, "actual-passenger-" + child)
                        page.get_by_test_id("onay-" + child + "-back").click()
                    page.get_by_test_id("onay-profile-theme-light").click()
                    shot(page, "actual-passenger-profile-light")
                    page.reload(wait_until="domcontentloaded")
                    page.get_by_test_id("onay-tab-home").click()
                    expect(page.get_by_test_id("onay-passenger-home")).to_be_visible()
                    shot(page, "actual-passenger-home-light-reload")
                    for width in (320, 390):
                        page.set_viewport_size({"width": width, "height": 640})
                        for tab in ("home", "trips", "chats", "profile"):
                            page.get_by_test_id("onay-tab-" + tab).click()
                            shot(page, f"actual-passenger-{tab}-{width}")
                    page.set_viewport_size({"width": 390, "height": 844})
                    page.get_by_test_id("onay-profile-theme-dark").click()
                    page.get_by_test_id("onay-profile-logout").click()
                    passed("Passenger: real UI OTP, six-digit guard, isolated booking, four tabs, profile, support, about, theme/reload and 320/390px")
                else:
                    expect(page.get_by_test_id("onay-driver-v2")).to_be_visible()
                    expect(page.get_by_text("Профиль на проверке", exact=True)).to_be_visible()
                    expect(page.get_by_test_id("driver-queue-join")).to_have_count(0)
                    for width in (320, 390):
                        page.set_viewport_size({"width": width, "height": 844})
                        for tab in ("line", "queue", "chats", "history", "profile"):
                            page.get_by_test_id("onay-driver-tab-" + tab).click()
                            shot(page, f"actual-driver-{tab}-{width}")
                    page.get_by_test_id("onay-driver-car-edit").click()
                    expect(page.get_by_test_id("driver-vehicle-save")).to_be_visible()
                    shot(page, "actual-driver-car")
                    page.get_by_test_id("onay-screen-back").click()
                    page.get_by_test_id("onay-driver-logout").click()
                    passed("Driver: real UI OTP, five tabs at320/390, approval guard, profile and car editor navigation")
                expect(page.get_by_test_id("onay-auth-phone")).to_be_visible()
            assert not report["pageErrors"], "Unexpected app runtime errors"
            context.close()
            # Decode only the pinned reference, in a context isolated from the real app/API.
            root = Path(__file__).resolve().parents[1] / "design/onay"
            wrapper = (root / "Onay.html").read_text()
            metadata = json.loads((root / "reference.json").read_text())
            assert hashlib.sha256(wrapper.encode()).hexdigest() == metadata["sha256"]
            reference = browser.new_context(viewport={"width": 390, "height": 844})
            reference_page = reference.new_page()
            for role, encoded in re.findall(r'(passenger|driver):"([A-Za-z0-9+/=]+)"', wrapper):
                raw = base64.b64decode(encoded)
                assert hashlib.sha256(raw).hexdigest() == metadata[role + "Sha256"]
                reference_page.goto("about:blank")  # reset each prototype's independent JS globals
                reference_page.set_content(raw.decode(), wait_until="load")
                # The public source schedules its first navigation at 1000ms.
                # Capture after that transition, not halfway through its fade.
                reference_page.wait_for_timeout(1500)
                reference_page.evaluate("S.auth = false; reset('welcome')")
                reference_page.wait_for_timeout(450)
                reference_page.screenshot(path=str(args.output_dir / f"reference-{role}-auth.png"))
                for state in (["home", "builder", "trips", "history", "chats", "profile", "support", "about", "pdata"] if role == "passenger" else ["line", "queue", "history", "profile"]):
                    reference_page.evaluate("state => { S.auth = true; if (state === 'builder') S.draft = newDraft('A'); reset(state); }", state)
                    reference_page.wait_for_timeout(450)
                    reference_page.screenshot(path=str(args.output_dir / f"reference-{role}-{state}.png"))
            reference.close()
            browser.close()
            passed("Pinned published HTML and decoded role sources verified by SHA256; reference screenshots captured separately")
            report["status"] = "passed"
    except Exception as error:
        report["error"] = helpers.redact(str(error))
        print(helpers.redact(traceback.format_exc()))
    finally:
        report["screenshots"] = sorted(path.name for path in args.output_dir.glob("*.png"))
        pairs = [("Вход", "reference-passenger-auth", "actual-unconfigured-auth"),
                 ("Главная пассажира", "reference-passenger-home", "actual-passenger-home"),
                 ("Оформление", "reference-passenger-builder", "actual-passenger-builder"),
                 ("Поездки", "reference-passenger-trips", "actual-passenger-trips"),
                 ("История пассажира", "reference-passenger-history", "actual-passenger-history"),
                 ("Личные данные", "reference-passenger-pdata", "actual-passenger-personal-data"),
                 ("О приложении", "reference-passenger-about", "actual-passenger-about"),
                 ("Профиль пассажира", "reference-passenger-profile", "actual-passenger-profile"),
                 ("Поддержка", "reference-passenger-support", "actual-passenger-support"),
                 ("Линия водителя", "reference-driver-line", "actual-driver-line-390"),
                 ("Очередь", "reference-driver-queue", "actual-driver-queue-390"),
                 ("История водителя", "reference-driver-history", "actual-driver-history-390"),
                 ("Профиль водителя", "reference-driver-profile", "actual-driver-profile-390")]
        gallery = '<!doctype html><meta charset="utf-8"><title>Onay: HTML / React Native</title><style>body{font:16px system-ui;background:#eee;color:#15271e;margin:24px}section{margin:32px 0}div{display:flex;gap:20px;flex-wrap:wrap}figure{margin:0}img{width:390px;max-width:100%;border:1px solid #999}figcaption{padding:10px 0}</style><h1>Onay: опубликованный HTML / настоящее приложение</h1><p>Разные реальные данные и состояния. Эта галерея помогает ручному сравнению и не доказывает попиксельное совпадение. Android не проверен.</p>'
        for title, reference_name, actual_name in pairs:
            gallery += '<section><h2>' + html.escape(title) + '</h2><div>'
            for label, name in [("Утверждённый HTML", reference_name), ("React Native Web, реальный API", actual_name)]:
                if name + ".png" in report["screenshots"]:
                    gallery += '<figure><figcaption>' + label + '</figcaption><img src="' + name + '.png" alt="' + html.escape(title + " — " + label) + '"></figure>'
            gallery += '</div></section>'
        (args.output_dir / "comparison.html").write_text(gallery)
        (args.output_dir / "verification.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
