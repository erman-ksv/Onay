#!/usr/bin/env python3
"""Exercise the isolated offline preview; any API call or socket during demo fails QA."""
import argparse
import json
from pathlib import Path
import traceback
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:4176")
    parser.add_argument("--live-url", default="http://127.0.0.1:4175")
    parser.add_argument("--output-dir", type=Path, default=Path("/tmp/onay-demo-qa"))
    args = parser.parse_args()
    for origin in (args.base_url, args.live_url):
        parsed = urlparse(origin)
        assert parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        assert parsed.path in {"", "/"} and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = {"status": "failed", "checks": [], "apiRequests": [], "sockets": [], "pageErrors": [],
              "scope": "RN Web static offline demo; physical Android remains untested"}
    active = [False]

    def passed(label):
        report["checks"].append(label)
        print("PASS:", label, flush=True)

    def shot(page, name):
        page.wait_for_timeout(450)
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), name + " overflow"
        page.screenshot(path=str(args.output_dir / (name + ".png")))

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            fresh = browser.new_context(viewport={"width": 390, "height": 844}, locale="ru-RU")
            first = fresh.new_page()
            first.goto(args.base_url, wait_until="domcontentloaded")
            expect(first.get_by_test_id("onay-auth-demo")).to_be_enabled()
            assert first.evaluate("localStorage.getItem('tezjet_api_endpoint')") is None
            assert first.evaluate("localStorage.getItem('tezjet_access_token')") is None
            shot(first, "demo-first-launch")
            fresh.close()
            passed("Fresh APK with no saved endpoint or session exposes demo directly from auth")
            context = browser.new_context(viewport={"width": 390, "height": 844}, locale="ru-RU")
            context.add_init_script("localStorage.setItem('tezjet_api_endpoint', 'http://127.0.0.1:59999')")
            page = context.new_page(); page.set_default_timeout(20000)
            page.on("pageerror", lambda e: report["pageErrors"].append(str(e)))
            page.on("request", lambda req: report["apiRequests"].append({"path": urlparse(req.url).path, "method": req.method}) if active[0] and urlparse(req.url).path.startswith("/api/") else None)
            page.on("websocket", lambda socket: report["sockets"].append("unexpected-demo-socket") if active[0] else None)
            page.route("**/api/**", lambda route: route.abort("blockedbyclient"))
            page.goto(args.base_url, wait_until="domcontentloaded")
            expect(page.get_by_test_id("onay-auth-demo")).to_be_enabled()
            assert page.evaluate("localStorage.getItem('tezjet_access_token')") is None
            shot(page, "demo-entry")
            active[0] = True
            page.get_by_test_id("onay-auth-demo").click()
            expect(page.get_by_test_id("onay-demo-app")).to_be_visible()
            expect(page.get_by_test_id("onay-passenger-home")).to_be_visible()
            shot(page, "demo-passenger-home")
            passed("Demo opens with no phone, SMS, OTP or server; explicit demo banner stays visible")

            page.get_by_test_id("onay-home-to-city").click()
            expect(page.get_by_test_id("onay-demo-page")).to_be_visible()
            page.get_by_test_id("onay-demo-seat-plus").click()
            expect(page.get_by_test_id("onay-demo-seats")).to_have_text("2")
            shot(page, "demo-booking")
            page.get_by_test_id("onay-demo-preview-trip").click()
            expect(page.get_by_test_id("onay-demo-page")).to_have_count(0)
            expect(page.get_by_test_id("passenger-trip-onay-demo-ride")).to_be_visible()
            page.get_by_test_id("onay-ride-open-onay-demo-ride").click()
            expect(page.get_by_test_id("onay-ride-details-onay-demo-ride")).to_contain_text("ДЕМО")
            shot(page, "demo-passenger-ride")
            page.get_by_test_id("onay-screen-back").click()
            expect(page.get_by_test_id("onay-ride-details-onay-demo-ride")).to_have_count(0)
            passed("Passenger booking and ride details use clearly labelled in-memory examples")

            page.get_by_test_id("onay-tab-profile").click()
            page.get_by_test_id("onay-profile-personal-data").click()
            expect(page.get_by_test_id("onay-profile-personal-name")).to_have_text("Демо-пассажир")
            page.get_by_test_id("onay-screen-back").click()
            page.get_by_test_id("onay-profile-support").click()
            expect(page.get_by_test_id("onay-demo-page")).to_contain_text("сообщения не отправляются")
            page.get_by_test_id("onay-screen-back").click()
            expect(page.get_by_test_id("onay-demo-page")).to_have_count(0)
            page.get_by_test_id("onay-profile-theme-light").click()
            for width in (320, 390):
                page.set_viewport_size({"width": width, "height": 844})
                for tab in ("home", "trips", "chats", "profile"):
                    page.get_by_test_id("onay-tab-" + tab).click()
                    shot(page, f"demo-passenger-{tab}-light-{width}")
            page.get_by_test_id("onay-profile-history").click()
            page.get_by_test_id("onay-demo-history-row-onay-demo-history").click()
            expect(page.get_by_test_id("onay-passenger-history-details-onay-demo-history")).to_be_visible()
            shot(page, "demo-passenger-history-details")
            page.get_by_test_id("onay-screen-back").click()
            expect(page.get_by_test_id("onay-passenger-history-details-onay-demo-history")).to_have_count(0)
            passed("Passenger tabs, personal data, history, support, light theme and 320/390px work offline")

            page.get_by_test_id("onay-demo-role-driver").click()
            expect(page.get_by_test_id("onay-driver-v2")).to_be_visible()
            for width in (320, 390):
                page.set_viewport_size({"width": width, "height": 844})
                for tab in ("line", "queue", "chats", "history", "profile"):
                    page.get_by_test_id("onay-driver-tab-" + tab).click()
                    shot(page, f"demo-driver-{tab}-{width}")
            page.get_by_test_id("onay-driver-theme-dark").click()
            page.get_by_test_id("onay-driver-car-edit").click()
            page.get_by_test_id("onay-demo-car").fill("Демо автомобиль QA")
            page.get_by_test_id("onay-demo-plate").fill("DEMO-QA")
            page.get_by_test_id("onay-demo-car-done").click()
            expect(page.get_by_test_id("onay-demo-page")).to_have_count(0)
            expect(page.get_by_test_id("onay-driver-profile-v2")).to_contain_text("Демо автомобиль QA")
            page.get_by_test_id("onay-driver-tab-queue").click()
            page.get_by_test_id("onay-demo-queue-route").click()
            page.get_by_test_id("onay-demo-route-reverse").click()
            page.get_by_test_id("onay-demo-route-done").click()
            expect(page.get_by_test_id("onay-demo-page")).to_have_count(0)
            page.get_by_test_id("onay-driver-tab-line").click()
            page.get_by_test_id("onay-driver-online").click()
            expect(page.get_by_test_id("onay-driver-online")).to_have_attribute("aria-checked", "true")
            for status in ("Ищем водителя", "Водитель едет к точке подачи", "Водитель прибыл", "Ты в машине. Ожидаем отправления водителя", "Поездка началась"):
                expect(page.get_by_test_id("onay-demo-driver-order")).to_contain_text(status)
                page.get_by_test_id("onay-demo-driver-progress").click()
            expect(page.get_by_test_id("onay-demo-driver-order")).to_have_count(0)
            page.get_by_test_id("onay-driver-tab-history").click()
            expect(page.get_by_test_id("onay-demo-history-row-onay-demo-ride")).to_contain_text("Поездка завершена")
            shot(page, "demo-driver-completed-history")
            passed("Driver tabs, local car/route examples and entire sample ride run without a dispatcher")

            assert report["apiRequests"] == [] and report["sockets"] == [], "Demo must never contact an API or open a socket"
            active[0] = False
            page.get_by_test_id("onay-demo-exit").click()
            expect(page.get_by_test_id("onay-auth-demo")).to_be_visible()
            expect(page.get_by_test_id("onay-demo-app")).to_have_count(0)
            assert page.evaluate("localStorage.getItem('tezjet_access_token')") is None
            assert page.evaluate("localStorage.getItem('tezjet_api_endpoint')") == "http://127.0.0.1:59999"
            page.reload(wait_until="domcontentloaded")
            expect(page.get_by_test_id("onay-auth-demo")).to_be_enabled()
            active[0] = True
            page.get_by_test_id("onay-auth-role-switch").click()
            page.get_by_test_id("onay-auth-demo").click()
            expect(page.get_by_test_id("onay-driver-v2")).to_be_visible()
            expect(page.get_by_test_id("onay-demo-driver-order")).to_have_count(0)
            page.get_by_test_id("onay-driver-tab-profile").click()
            expect(page.get_by_test_id("onay-driver-profile-v2")).not_to_contain_text("Демо автомобиль QA")
            active[0] = False
            page.get_by_test_id("onay-demo-exit").click()
            assert report["apiRequests"] == [] and report["sockets"] == []
            passed("Exit/restart restore ordinary auth, discard preview changes and mint no token or session")

            page.goto(args.live_url + "?demo=true", wait_until="domcontentloaded")
            expect(page.get_by_test_id("onay-auth-phone")).to_be_visible()
            expect(page.get_by_test_id("onay-auth-demo")).to_have_count(0)
            assert report["pageErrors"] == [], report["pageErrors"]
            passed("Normal build has no offline-demo entry even with a demo query parameter")
            context.close(); browser.close()
            report["status"] = "passed"
    except Exception as error:
        report["error"] = str(error)
        print(traceback.format_exc())
    finally:
        report["screenshots"] = sorted(p.name for p in args.output_dir.glob("*.png"))
        (args.output_dir / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
