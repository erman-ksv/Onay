#!/usr/bin/env python3
"""Exercise the actual Expo app against a real local API/PostgreSQL service.

Browser plugin not available; the explicit CI browser task uses pinned Python
Playwright/Chromium. Requests, GPS, authentication, and route data are not mocked.
The existing development OTP response is used only with local nonproduction API.
"""

import argparse
import json
import os
import re
import sys
import traceback
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def redact(value):
    if isinstance(value, dict):
        return {
            key: "[redacted]"
            if key.lower() in {"access_token", "authorization", "demo_code", "session_secret"}
            or (key.lower() == "code" and isinstance(item, str) and re.fullmatch(r"\d{6}", item))
            else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        return re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[redacted-token]", value)
    return value


def api_request(origin, pathname, method="GET", body=None, token=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None if body is None else json.dumps(body).encode()
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = Request(origin.rstrip("/") + "/api" + pathname, data=data, headers=headers, method=method)
    try:
        response = urlopen(request, timeout=15)
    except HTTPError as error:
        response = error
    with response:
        content = response.read().decode()
        return response.status, json.loads(content) if content else None


def expect_status(result, status, description):
    actual, body = result
    require(actual == status, f"{description}: expected HTTP {status}, got {actual}: {redact(body)}")
    return body


class DriverRouteQA:
    def __init__(self, args, context, page, expect):
        self.args, self.context, self.page, self.expect = args, context, page, expect
        self.checks = []
        self.console = []
        self.page_errors = []
        self.requests = []
        self.responses = []
        self.routes = []
        self.admin_token = None
        self.driver_token = None
        self.driver_id = None
        self.conflict_observed = False
        self.page_identity = {}
        page.on("console", self.on_console)
        page.on("pageerror", lambda error: self.page_errors.append(redact(str(error))))
        page.on("request", self.on_request)
        page.on("response", self.on_response)
        page.on("dialog", lambda dialog: dialog.accept())

    def on_console(self, message):
        if message.type in {"warning", "error"}:
            self.console.append({"type": message.type, "text": redact(message.text), "url": message.location.get("url", "")})

    def on_request(self, request):
        parsed = urlparse(request.url)
        if parsed.path.startswith("/api/"):
            # Never record headers, OTP bodies, or session responses.
            item = {"path": parsed.path, "method": request.method}
            if parsed.path == "/api/driver/route" and request.method == "PUT":
                item["body"] = redact(request.post_data_json)
            self.requests.append(item)

    def on_response(self, response):
        parsed = urlparse(response.url)
        if parsed.path.startswith("/api/"):
            self.responses.append({"path": parsed.path, "method": response.request.method, "status": response.status})

    def passed(self, name):
        self.checks.append({"name": name, "status": "passed"})
        print("PASS:", name, flush=True)

    def response_for(self, pathname, method):
        return self.page.expect_response(
            lambda response: urlparse(response.url).path == "/api" + pathname and response.request.method == method,
            timeout=20_000,
        )

    def screenshot(self, name):
        self.page.screenshot(path=str(self.args.output_dir / (name + ".png")), full_page=True)

    def control(self, test_id):
        return self.page.get_by_test_id(test_id)

    def identity(self):
        require(self.page.url.rstrip("/") == self.args.base_url.rstrip("/"), "Browser must show the actual Expo home page")
        self.expect(self.page.locator("#root")).not_to_be_empty()
        self.expect(self.page.get_by_text("TezJet Driver", exact=True)).to_be_visible()
        self.expect(self.page.get_by_role("button", name="Водитель", exact=True)).to_be_visible()
        require(self.page.locator("vite-error-overlay, nextjs-portal, [data-nextjs-dialog-overlay]").count() == 0, "Framework error overlay is visible")
        require(self.page.get_by_text(re.compile(r"Uncaught Error|Something went wrong|LogBox"), exact=False).count() == 0, "Expo runtime error overlay is visible")
        self.page_identity = {"url": self.page.url, "title": self.page.title(), "content": "TezJet Driver"}

    def admin_login_and_routes(self):
        challenge = expect_status(api_request(self.args.api_url, "/auth/request-otp", method="POST", body={
            "phone_number": self.args.admin_phone, "full_name": "CI route administrator", "role": "admin", "locale": "ru",
        }), 202, "Real administrator OTP request")
        code = challenge.get("demo_code", "")
        require(bool(re.fullmatch(r"\d{6}", code)), "Existing nonproduction OTP response must supply the administrator code")
        session = expect_status(api_request(self.args.api_url, "/auth/verify-otp", method="POST", body={
            "phone_number": self.args.admin_phone, "code": code,
        }), 200, "Real administrator OTP verification")
        require(session.get("user", {}).get("role") == "admin", "Setup must authenticate a real administrator")
        self.admin_token = session["access_token"]
        suffix = uuid.uuid4().hex[:10]
        for index in (1, 2):
            created = expect_status(api_request(self.args.api_url, "/admin/routes", method="POST", token=self.admin_token, body={
                "name": f"QA маршрут {index} {suffix}", "active": True,
            }), 201, "Create real administrator route")["route"]
            names = [f"QA {index} питак А", f"QA {index} середина", f"QA {index} питак Б"]
            route = expect_status(api_request(self.args.api_url, "/admin/routes/" + created["id"] + "/layout", method="PUT", token=self.admin_token, body={
                "expected_updated_at": created["updatedAt"],
                "stops": [{"code": code, "name": name, "location": {"lat": 42.9 + index * 0.01 + position * 0.01, "lng": 71.3 + position * 0.03}}
                          for position, (code, name) in enumerate(zip(("A", "M", "B"), names))],
                "pitaks": {"a_stop_code": "A", "b_stop_code": "B", "radius_meters": 175},
            }), 200, "Persist real A/B route layout")["route"]
            require([stop["code"] for stop in route["stops"]] == ["A", "M", "B"], "Real route must have canonical ordered stops")
            require(route.get("pitaks") == {"aStopCode": "A", "bStopCode": "B", "radiusMeters": 175}, "Real A/B endpoints must persist")
            self.routes.append(route)
        self.passed("Real admin OTP creates two configured routes in PostgreSQL")

    def driver_login_and_approval(self):
        self.page.goto(self.args.base_url, wait_until="domcontentloaded")
        self.page.get_by_role("button", name="Водитель", exact=True).click()
        self.expect(self.page.get_by_text("Вход или регистрация водителя", exact=True)).to_be_visible()
        self.page.get_by_placeholder("Твоё имя", exact=True).fill("CI route driver")
        phone = "+77779" + str(uuid.uuid4().int % 1_000_000).zfill(6)
        self.page.get_by_placeholder("+998 90 123 45 67", exact=True).fill(phone)
        with self.response_for("/auth/request-otp", "POST") as pending:
            self.page.get_by_role("button", name="Получить код", exact=True).click()
        response = pending.value
        require(response.status == 202, "Actual app must request a real driver OTP")
        code = response.json().get("demo_code", "")
        require(bool(re.fullmatch(r"\d{6}", code)), "Existing nonproduction OTP response must supply the driver code")
        self.page.get_by_placeholder("Код подтверждения", exact=True).fill(code)
        with self.response_for("/auth/verify-otp", "POST") as pending:
            self.page.get_by_role("button", name="Продолжить как водитель", exact=True).click()
        response = pending.value
        require(response.status == 200, "Actual app must verify the driver OTP")
        session = response.json()
        user = session.get("user", {})
        require(user.get("active_role", user.get("role")) == "driver" and user.get("driver_approval_status") == "pending", "New driver must await actual administrator approval")
        self.driver_token, self.driver_id = session["access_token"], user["id"]
        self.expect(self.page.get_by_text("Профиль на проверке", exact=True)).to_be_visible()
        self.expect(self.control("driver-route-picker")).to_have_count(0)
        self.expect(self.control("driver-queue-join")).to_have_count(0)
        approved = expect_status(api_request(self.args.api_url, "/admin/drivers/" + self.driver_id + "/approval", method="PATCH", token=self.admin_token, body={"status": "approved"}), 200, "Real administrator driver approval")
        require(approved.get("driver", {}).get("driver_approval_status") == "approved", "Real administrator approval must persist")
        with self.response_for("/auth/me", "GET") as pending:
            self.page.get_by_role("button", name="Проверить статус", exact=True).click()
        require(pending.value.status == 200, "Actual app must reload its approved profile")
        self.expect(self.control("driver-route-picker")).to_be_visible()
        self.expect(self.control("driver-route-status")).to_contain_text("Маршрут не выбран. Можно использовать общую очередь.")
        self.expect(self.control("driver-queue-join")).to_be_enabled()
        self.identity()
        catalog = expect_status(api_request(self.args.api_url, "/driver/routes", token=self.driver_token), 200, "Read real driver route catalog")["routes"]
        for route in self.routes:
            actual = next((item for item in catalog if item["id"] == route["id"]), None)
            require(actual is not None and actual["updatedAt"] == route["updatedAt"], "Driver catalog must contain administrator-configured versions")
            self.expect(self.control("driver-route-" + route["id"])).to_contain_text(route["name"])
        self.passed("Actual Expo app performs driver OTP registration and waits for real approval")

    def snapshot(self):
        return expect_status(api_request(self.args.api_url, "/driver/route", token=self.driver_token), 200, "Read persisted driver route choice")

    def assert_stops(self, route, direction):
        names = [stop["name"] for stop in route["stops"]]
        if direction == "b_to_a":
            names.reverse()
        stops = self.control("driver-route-stops")
        self.expect(stops).to_be_visible()
        for name in names:
            self.expect(stops).to_contain_text(name)
        text = stops.inner_text()
        positions = [text.index(name) for name in names]
        require(positions == sorted(positions), "Actual displayed stop names must reverse with the selected direction")

    def select_draft(self, route, direction):
        saved_before = self.snapshot()
        self.control("driver-route-" + route["id"]).click()
        self.expect(self.control("driver-route-" + route["id"])).to_have_attribute("aria-checked", "true")
        a_name, b_name = route["stops"][0]["name"], route["stops"][-1]["name"]
        self.expect(self.page.get_by_role("radio", name=f"A → B: {a_name} → {b_name}", exact=True)).to_be_visible()
        self.expect(self.page.get_by_role("radio", name=f"B → A: {b_name} → {a_name}", exact=True)).to_be_visible()
        self.control("driver-direction-" + direction).click()
        self.expect(self.control("driver-direction-" + direction)).to_have_attribute("aria-checked", "true")
        self.assert_stops(route, direction)
        require(self.snapshot() == saved_before, "Changing route or direction must retain an unsaved local draft")
        self.expect(self.control("driver-route-save")).to_be_enabled()

    def assert_saved(self, route, direction):
        snapshot = self.snapshot()
        require(snapshot.get("choice") == {"routeId": route["id"], "direction": direction, "routeUpdatedAt": route["updatedAt"]}, "Real saved route ID, direction, and version must match the explicit selection")
        require(snapshot.get("unavailable_reason") is None and snapshot.get("route", {}).get("id") == route["id"], "Saved choice must resolve to its available real route")
        self.expect(self.control("driver-route-status")).to_contain_text("Сохранено: " + route["name"])
        self.expect(self.control("driver-route-status")).to_contain_text("A → B" if direction == "a_to_b" else "B → A")
        self.expect(self.control("driver-queue-join")).to_be_enabled()
        self.expect(self.control("driver-route-status")).to_contain_text("Очередь: питак " + ("A" if direction == "a_to_b" else "B"))

    def save(self, route, direction):
        with self.response_for("/driver/route", "PUT") as pending:
            self.control("driver-route-save").click()
        response = pending.value
        require(response.status == 200, "Explicit route save must succeed on the actual API")
        require(response.request.post_data_json == {"route_id": route["id"], "direction": direction, "expected_updated_at": route["updatedAt"]}, "Route save must submit the selected route version without GPS")
        self.assert_saved(route, direction)

    def reload_saved(self, route, direction):
        with self.response_for("/driver/route", "GET") as pending:
            self.page.reload(wait_until="domcontentloaded")
        require(pending.value.status == 200, "Browser reload must restore the real saved choice")
        self.expect(self.control("driver-route-" + route["id"])).to_have_attribute("aria-checked", "true")
        self.expect(self.control("driver-direction-" + direction)).to_have_attribute("aria-checked", "true")
        self.assert_stops(route, direction)
        self.assert_saved(route, direction)
        self.identity()

    def stale_conflict(self):
        route = self.routes[0]
        self.select_draft(route, "a_to_b")
        saved_before = self.snapshot()
        replacement = [{"id": stop["id"], "code": stop["code"], "name": stop["name"],
                        "location": {"lat": stop["location"]["lat"], "lng": stop["location"]["lng"]}}
                       for stop in route["stops"]]
        replacement[1]["name"] += " обновлена"
        changed = expect_status(api_request(self.args.api_url, "/admin/routes/" + route["id"] + "/layout", method="PUT", token=self.admin_token, body={
            "expected_updated_at": route["updatedAt"], "stops": replacement,
            "pitaks": {"a_stop_code": "A", "b_stop_code": "B", "radius_meters": 175},
        }), 200, "Concurrent real administrator layout change")["route"]
        require(changed["updatedAt"] != route["updatedAt"], "Concurrent route update must advance its version")
        with self.response_for("/driver/route", "PUT") as pending:
            self.control("driver-route-save").click()
        response = pending.value
        require(response.status == 409 and response.json().get("error", {}).get("code") == "ROUTE_CHANGED", "Stale draft must receive a real ROUTE_CHANGED conflict")
        require(response.request.post_data_json["expected_updated_at"] == route["updatedAt"], "Conflict must result from a genuinely stale route version")
        self.conflict_observed = True
        self.expect(self.page.get_by_text("Маршрут изменился. Проверь обновлённые остановки и сохрани выбор ещё раз.", exact=True)).to_be_visible()
        self.expect(self.control("driver-route-" + route["id"])).to_have_attribute("aria-checked", "true")
        self.expect(self.control("driver-direction-a_to_b")).to_have_attribute("aria-checked", "true")
        self.assert_stops(changed, "a_to_b")
        require(self.snapshot() == saved_before, "Rejected stale draft must retain the previous durable route choice")
        self.assert_saved(self.routes[1], "b_to_a")
        self.expect(self.control("driver-route-save")).to_be_enabled()
        self.screenshot("mobile-390-conflict-draft-retained")
        self.routes[0] = changed
        self.save(changed, "a_to_b")
        self.passed("Actual stale 409 preserves route/direction draft and prior saved choice before explicit retry")

    def clear_and_legacy(self):
        requests_before_clear = len(self.requests)
        with self.response_for("/driver/route", "DELETE") as pending:
            self.control("driver-route-clear").click()
        require(pending.value.status == 204, "Explicit route clear must delete the actual persisted choice")
        require(self.snapshot().get("choice") is None, "Cleared route choice must be absent on the server")
        self.expect(self.control("driver-route-status")).to_contain_text("Маршрут не выбран. Можно использовать общую очередь.")
        self.expect(self.control("driver-queue-join")).to_be_enabled()
        with self.response_for("/driver/route", "GET") as pending:
            self.page.reload(wait_until="domcontentloaded")
        require(pending.value.status == 200 and pending.value.json().get("choice") is None, "Reload must retain the cleared choice")
        self.expect(self.control("driver-queue-join")).to_be_enabled()
        self.expect(self.control("driver-route-status")).to_contain_text("Маршрут не выбран. Можно использовать общую очередь.")
        self.identity()
        self.screenshot("mobile-390-cleared-legacy-queue-enabled")
        forbidden = [item for item in self.requests[requests_before_clear:] if item["path"] in {"/api/queue/join", "/api/queue/location", "/api/orders"} and item["method"] != "GET"]
        require(not forbidden, "Planning QA must not join a queue, fabricate GPS, or place orders")
        self.passed("Clear survives reload and re-enables the legacy queue control without GPS or queue writes")

    def configured_queue_roundtrip(self, route, direction):
        # Browser geolocation is deliberately emulated in local CI. The actual
        # Expo Location API, HTTP authentication and PostgreSQL remain real.
        # This verifies the UI integration, not physical-device GPS accuracy.
        stop = route["stops"][0 if direction == "a_to_b" else -1]
        pitak = "A" if direction == "a_to_b" else "B"
        self.context.grant_permissions(["geolocation"], origin=self.args.base_url)
        self.context.set_geolocation({"latitude": stop["location"]["lat"], "longitude": stop["location"]["lng"], "accuracy": 5})
        with self.response_for("/queue/join", "POST") as pending:
            self.control("driver-queue-join").click()
        result = pending.value
        require(result.status == 201, "Actual Expo join must persist the configured queue")
        require(result.request.post_data_json["route_choice"] == {
            "route_id": route["id"], "direction": direction, "expected_updated_at": route["updatedAt"],
        }, "App must bind entry to its exact saved choice")
        entry = result.json()["entry"]
        require(entry["routeContext"]["routeId"] == route["id"] and entry["routeContext"]["pitak"] == pitak, "Server must derive the correct route/pitak")
        self.expect(self.control("driver-queue-context")).to_contain_text(route["name"])
        self.expect(self.control("driver-queue-context")).to_contain_text("питак " + pitak)
        self.expect(self.control("driver-queue-status")).to_contain_text("позиция 1")
        self.expect(self.control("driver-route-save")).to_be_disabled()
        self.control("driver-queue-context").screenshot(path=str(self.args.output_dir / ("queue-" + pitak + "-persisted.png")))
        with self.response_for("/queue", "GET") as pending:
            self.page.reload(wait_until="domcontentloaded")
        require(pending.value.status == 200 and pending.value.json()["your_position"] == 1, "Reopening must restore the durable lane position")
        self.expect(self.control("driver-queue-context")).to_contain_text("питак " + pitak)
        self.expect(self.control("driver-route-save")).to_be_disabled()
        with self.response_for("/queue/location", "PATCH") as pending:
            self.control("driver-queue-location").click()
        require(pending.value.status == 200, "Actual location button must update within its own pitak zone")
        with self.response_for("/queue/leave", "DELETE") as pending:
            self.control("driver-queue-leave").click()
        require(pending.value.status == 204, "Actual leave must delete the durable enrollment")
        self.expect(self.control("driver-queue-status")).to_contain_text("не в очереди")
        self.expect(self.control("driver-queue-context")).to_have_count(0)
        self.expect(self.control("driver-route-save")).to_be_enabled()
        self.passed("Actual app joins, restores, updates location and leaves pitak " + pitak + " using browser-emulated geolocation")

    def assert_console_health(self):
        unexpected = []
        for entry in self.console:
            if entry["type"] != "error":
                continue
            expected_conflict = self.conflict_observed and urlparse(entry["url"]).path == "/api/driver/route" and bool(re.fullmatch(r"Failed to load resource: the server responded with a status of 409 \(Conflict\)", entry["text"]))
            if not expected_conflict:
                unexpected.append(entry)
        require(not unexpected and not self.page_errors, f"Browser errors: {redact(unexpected)}; page errors: {redact(self.page_errors)}")

    def run(self):
        expect_status(api_request(self.args.api_url, "/healthz"), 200, "Actual API health")
        self.admin_login_and_routes()
        self.driver_login_and_approval()
        for route in self.routes:
            for direction in ("a_to_b", "b_to_a"):
                self.select_draft(route, direction)
                self.save(route, direction)
        self.passed("Both actual routes save both A/B directions with reversed administrator stop names")
        final_route = self.routes[1]
        self.reload_saved(final_route, "b_to_a")
        self.passed("Saved route/direction restore after reopening the actual Expo app")
        self.page.evaluate("window.scrollTo(0, 0)")
        self.screenshot("desktop-saved-route-reverse")
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.assert_stops(final_route, "b_to_a")
        self.assert_saved(final_route, "b_to_a")
        require(self.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "390px picker must not overflow horizontally")
        self.page.evaluate("window.scrollTo(0, 0)")
        self.screenshot("mobile-390-saved-route-reverse")
        self.passed("Desktop and 390px route picker render real saved direction and correct queue control")
        self.stale_conflict()
        self.configured_queue_roundtrip(self.routes[0], "a_to_b")
        # A fresh real driver avoids pretending an instant A→B teleport passes
        # the existing GPS speed guard. The first driver's enrollment is gone.
        self.page.get_by_text("Выйти", exact=True).click()
        self.driver_login_and_approval()
        self.select_draft(self.routes[0], "b_to_a")
        self.save(self.routes[0], "b_to_a")
        self.configured_queue_roundtrip(self.routes[0], "b_to_a")
        self.clear_and_legacy()
        self.assert_console_health()
        self.passed("No unexpected browser errors, blank app, or framework overlays")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:4174")
    parser.add_argument("--api-url", default="http://127.0.0.1:5000")
    parser.add_argument("--admin-phone", default=os.environ.get("ADMIN_PHONE"))
    parser.add_argument("--output-dir", type=Path, default=Path("/tmp/driver-route-qa"))
    args = parser.parse_args()
    require(os.environ.get("NODE_ENV") in {"test", "development"}, "QA requires the local nonproduction OTP configuration")
    require(bool(args.admin_phone), "ADMIN_PHONE must match the API's test administrator")
    for origin in (args.base_url, args.api_url):
        parsed = urlparse(origin)
        require(parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"} and parsed.path in {"", "/"} and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment, "QA URLs must address local root CI services")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = {"status": "failed", "environment": {
        "base_url": args.base_url, "api_url": args.api_url, "browser": "Chromium / Python Playwright",
        "browser_plugin": "not available", "fallback_reason": "Browser plugin not available",
        "viewports": [{"width": 1440, "height": 1000}, {"width": 390, "height": 844}],
        "geolocation": "browser API emulation for local CI; physical-device GPS remains untested",
    }, "scope": "4.5 choice regression and 4.6 configured A/B enrollment; configured order dispatch and real GPS remain untested", "checks": []}
    qa = None
    exit_code = 1
    try:
        from playwright.sync_api import expect, sync_playwright
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="ru-RU")
            page = context.new_page()
            page.set_default_timeout(20_000)
            qa = DriverRouteQA(args, context, page, expect)
            try:
                qa.run()
                report["status"] = "passed"
                exit_code = 0
            except Exception:
                try:
                    qa.screenshot("failure")
                except Exception:
                    pass
                raise
            finally:
                context.close()
                browser.close()
    except Exception as error:
        report["error"] = redact(str(error))
        print(redact(traceback.format_exc()), file=sys.stderr)
    finally:
        if qa:
            report.update({"checks": qa.checks, "page_identity": qa.page_identity, "route_ids": [route["id"] for route in qa.routes],
                           "driver_id": qa.driver_id, "page_errors": qa.page_errors, "requests": qa.requests, "responses": qa.responses})
            (args.output_dir / "console.log").write_text("\n".join(json.dumps(redact(entry), ensure_ascii=False) for entry in qa.console) + "\n", encoding="utf-8")
        report["screenshots"] = sorted(file.name for file in args.output_dir.glob("*.png"))
        (args.output_dir / "verification.json").write_text(json.dumps(redact(report), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
