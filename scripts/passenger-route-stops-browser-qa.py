#!/usr/bin/env python3
"""Verify passenger stop selection in actual Expo against local API/PostgreSQL.

Uses the existing development OTP response and browser-emulated geolocation;
neither HTTP responses nor dispatch/storage are mocked. Physical GPS is separate.
"""

import argparse
import importlib.util
import json
import math
import os
import re
import sys
import time
import traceback
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location("driver_route_qa", Path(__file__).with_name("driver-route-browser-qa.py"))
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
require, api_request = shared.require, shared.api_request


class PassengerStopsQA:
    def __init__(self, args, context, page, expect):
        self.args, self.context, self.page, self.expect = args, context, page, expect
        self.checks, self.console, self.page_errors, self.requests = [], [], [], []
        self.secrets, self.drivers = set(), []
        self.admin_token = self.passenger_token = self.order_id = None
        self.expected_network_console = []
        self.disconnect_injected = False
        self.recovery_lookup_path = None
        self.closed_request_key = None
        self.route = None
        page.on("console", self.on_console)
        page.on("pageerror", lambda error: self.page_errors.append(self.safe(str(error))))
        page.on("request", self.on_request)
        page.on("dialog", lambda dialog: dialog.accept())

    def safe(self, value):
        value = shared.redact(value)
        if isinstance(value, dict):
            return {key: self.safe(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self.safe(item) for item in value]
        if isinstance(value, str):
            for secret in self.secrets:
                value = value.replace(secret, "[redacted]")
        return value

    def remember(self, value):
        if isinstance(value, str) and value:
            self.secrets.add(value)
        return value

    def on_console(self, message):
        # Account only for the single explicitly injected transport failure and
        # the exact missing-receipt lookup it causes. Other errors still fail QA.
        path = urlparse(message.location.get("url", "")).path
        if message.type == "error" and self.disconnect_injected:
            expected = ((path == "/api/orders/route" and "net::ERR_" in message.text and
                not any(item["kind"] == "transport" for item in self.expected_network_console)) or
                (path == self.recovery_lookup_path and "404" in message.text and
                not any(item["kind"] == "lookup404" for item in self.expected_network_console)))
            if expected:
                self.expected_network_console.append({"kind": "transport" if path == "/api/orders/route" else "lookup404", "text": self.safe(message.text)})
                return
        if message.type in {"warning", "error"}:
            self.console.append({"type": message.type, "text": self.safe(message.text)})

    def on_request(self, request):
        parsed = urlparse(request.url)
        if parsed.path in {"/api/orders/route", "/api/orders/route/availability"}:
            item = {"path": parsed.path, "method": request.method}
            if request.method == "POST":
                item["body"] = self.safe(request.post_data_json)
            elif parsed.query:
                item["query"] = parse_qs(parsed.query)
            self.requests.append(item)

    def expected(self, result, status, description):
        actual, body = result
        require(actual == status, f"{description}: expected HTTP {status}, got {actual}: {self.safe(body)}")
        return body

    def passed(self, description):
        self.checks.append({"name": description, "status": "passed"})
        print("PASS:", description, flush=True)

    def control(self, test_id):
        return self.page.get_by_test_id(test_id)

    def response_for(self, path, method):
        return self.page.expect_response(lambda response:
            urlparse(response.url).path == "/api" + path and response.request.method == method,
            timeout=20_000)

    def screenshot(self, name):
        self.page.screenshot(path=str(self.args.output_dir / (name + ".png")), full_page=True,
            mask=[self.page.get_by_placeholder("Код подтверждения", exact=True),
                  self.page.get_by_text(re.compile(r"Тестовый код:"))])

    def challenge(self, phone, role, admin=False):
        body = {"phone_number": phone, "full_name": "CI passenger stops " + role, "role": role, "locale": "ru"}
        # The preceding driver QA used the same administrator. Respect one real
        # Retry-After cooldown; never bypass limits or repeat the whole task.
        if admin:
            for attempt in range(2):
                request = Request(self.args.api_url.rstrip("/") + "/api/auth/request-otp",
                    data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
                try:
                    response = urlopen(request, timeout=15)
                except HTTPError as error:
                    response = error
                with response:
                    status = response.status
                    value = json.loads(response.read().decode())
                    retry_after = response.headers.get("Retry-After", "")
                if status != 429 or attempt == 1:
                    challenge = self.expected((status, value), 202, "Administrator OTP request")
                    break
                require(re.fullmatch(r"\d+", retry_after) is not None, "OTP cooldown must supply numeric Retry-After")
                seconds = int(retry_after)
                require(0 < seconds <= 60, "Administrator OTP cooldown exceeds the single bounded 60-second wait")
                time.sleep(seconds)
        else:
            challenge = self.expected(api_request(self.args.api_url, "/auth/request-otp", "POST", body), 202, "Fixture OTP request")
        code = self.remember(challenge.get("demo_code", ""))
        require(bool(re.fullmatch(r"\d{6}", code)), "Local development OTP must supply a six-digit code")
        return code

    def login_fixture(self, role, phone=None, admin=False):
        phone = phone or "+77778" + str(uuid.uuid4().int % 1_000_000).zfill(6)
        code = self.challenge(phone, role, admin)
        session = self.expected(api_request(self.args.api_url, "/auth/verify-otp", "POST",
            {"phone_number": phone, "code": code}), 200, "Fixture OTP verification")
        return self.remember(session["access_token"]), session["user"]

    def setup(self):
        self.expected(api_request(self.args.api_url, "/healthz"), 200, "Local API health")
        self.admin_token, user = self.login_fixture("admin", self.args.admin_phone, admin=True)
        require(user.get("role") == "admin", "Route setup requires the authenticated administrator")
        created = self.expected(api_request(self.args.api_url, "/admin/routes", "POST", {
            "name": "QA пассажирские остановки " + uuid.uuid4().hex[:10], "active": True,
        }, self.admin_token), 201, "Create configured route")["route"]
        self.route = self.expected(api_request(self.args.api_url, "/admin/routes/" + created["id"] + "/layout", "PUT", {
            "expected_updated_at": created["updatedAt"],
            "stops": [{"code": code, "name": "QA остановка " + code,
                "location": {"lat": 42.9 + index * 0.01, "lng": 71.3 + index * 0.03}}
                for index, code in enumerate(("A", "C", "D", "B"))],
            "pitaks": {"a_stop_code": "A", "b_stop_code": "B", "radius_meters": 175},
        }, self.admin_token), 200, "Persist A/C/D/B coordinates")["route"]
        require([stop["code"] for stop in self.route["stops"]] == ["A", "C", "D", "B"], "Configured stops must retain order")
        for direction in ("a_to_b", "b_to_a", "b_to_a"):
            token, driver = self.login_fixture("driver")
            self.expected(api_request(self.args.api_url, "/admin/drivers/" + driver["id"] + "/approval", "PATCH",
                {"status": "approved"}, self.admin_token), 200, "Approve fixture driver")
            choice = {"route_id": self.route["id"], "direction": direction, "expected_updated_at": self.route["updatedAt"]}
            self.expected(api_request(self.args.api_url, "/driver/route", "PUT", choice, token), 200, "Save fixture lane")
            stop = self.route["stops"][0 if direction == "a_to_b" else -1]
            self.expected(api_request(self.args.api_url, "/queue/join", "POST", {"route_choice": choice,
                "available_seats": 4, "location": {**stop["location"], "timestamp": int(time.time() * 1_000)}}, token),
                201, "Enroll actual driver in its configured pitak")
            self.drivers.append({"token": token, "id": driver["id"], "direction": direction})
        self.passed("Real OTP, administrator route geometry and approved A/B queues persist in PostgreSQL")

    def stop(self, code):
        return next(stop for stop in self.route["stops"] if stop["code"] == code)

    def passenger_login(self):
        self.page.goto(self.args.base_url, wait_until="domcontentloaded")
        self.page.get_by_role("button", name="Пассажир", exact=True).click()
        self.page.get_by_placeholder("Твоё имя", exact=True).fill("CI stop selection passenger")
        self.page.get_by_placeholder("+998 90 123 45 67", exact=True).fill(
            "+77777" + str(uuid.uuid4().int % 1_000_000).zfill(6))
        with self.response_for("/auth/request-otp", "POST") as pending:
            self.page.get_by_role("button", name="Получить код", exact=True).click()
        require(pending.value.status == 202, "Actual passenger screen must request OTP")
        code = self.remember(pending.value.json().get("demo_code", ""))
        require(bool(re.fullmatch(r"\d{6}", code)), "Actual passenger must receive local test OTP")
        self.page.get_by_placeholder("Код подтверждения", exact=True).fill(code)
        with self.response_for("/auth/verify-otp", "POST") as pending:
            self.page.get_by_role("button", name="Войти как пассажир", exact=True).click()
        require(pending.value.status == 200, "Actual passenger screen must verify OTP")
        session = pending.value.json()
        self.passenger_token = self.remember(session["access_token"])
        require(session["user"].get("active_role", session["user"].get("role")) == "passenger", "Browser must authenticate passenger mode")
        self.expect(self.control("configured-route-passenger")).to_be_visible()
        self.control("passenger-route-" + self.route["id"]).click()
        self.expect(self.control("passenger-pickup-open")).to_contain_text(self.stop("A")["name"])
        self.expect(self.control("passenger-destination-open")).to_contain_text(self.stop("B")["name"])
        self.control("route-seats-plus").click()
        self.expect(self.control("route-book-trip")).to_be_disabled()
        self.passed("Actual Expo passenger OTP login loads the administrator route with default A-to-B endpoints")

    def choose(self, field, code):
        self.control("passenger-" + field + "-open").click()
        self.expect(self.control("passenger-stop-picker")).to_be_visible()
        option = self.control("passenger-" + field + "-" + self.stop(code)["id"])
        self.expect(option).to_be_enabled()
        option.click()
        self.expect(self.control("passenger-stop-picker")).to_have_count(0)
        self.expect(self.control("passenger-" + field + "-open")).to_contain_text(self.stop(code)["name"])

    def check_quote(self, direction, pickup, destination, driver_count):
        with self.response_for("/orders/route/availability", "GET") as pending:
            self.control("route-check-availability").click()
        response = pending.value
        require(response.status == 200, "Actual selected segment availability must succeed")
        query = parse_qs(urlparse(response.url).query)
        for key, expected in {"route_id": self.route["id"], "direction": direction,
            "expected_updated_at": self.route["updatedAt"], "seats": "2",
            "pickup_stop_id": self.stop(pickup)["id"], "destination_stop_id": self.stop(destination)["id"]}.items():
            require(query.get(key) == [expected], "Availability must bind the exact selected " + key)
        body = response.json()
        require(body.get("available") is True and body.get("eligible_driver_count") == driver_count,
            "Only matching-direction queued drivers must be available")
        fare = body["fare"]
        distance = max(1, math.ceil(abs(self.stop(destination)["position"] - self.stop(pickup)["position"])))
        require(fare["pickupStop"]["id"] == self.stop(pickup)["id"] and fare["destinationStop"]["id"] == self.stop(destination)["id"],
            "Server quote must resolve the exact stops")
        require(fare["totalKzt"] == distance * self.route["pricePerStopKzt"], "Server quote must use the configured segment tariff")
        self.expect(self.control("route-book-trip")).to_be_enabled()
        text = re.sub(r"\s", "", self.control("configured-route-passenger").inner_text())
        require(str(fare["totalKzt"]) + "₸" in text, "Actual screen must display the server-confirmed price")
        return fare

    def forward_and_invalid_selection(self):
        self.choose("pickup", "C")
        self.check_quote("a_to_b", "C", "B", 1)
        self.screenshot("desktop-forward-C-to-B")
        self.passed("Forward C-to-B availability and displayed fare use the exact selected stops and A queue")
        self.control("passenger-destination-open").click()
        for code in ("A", "C"):
            self.expect(self.control("passenger-destination-" + self.stop(code)["id"])).to_be_disabled()
        self.control("passenger-destination-" + self.stop("D")["id"]).click()
        self.expect(self.control("passenger-stop-picker")).to_have_count(0)
        self.expect(self.control("route-book-trip")).to_be_disabled()
        self.control("passenger-pickup-open").click()
        for code in ("D", "B"):
            self.expect(self.control("passenger-pickup-" + self.stop(code)["id"])).to_be_disabled()
        self.expect(self.control("passenger-pickup-" + self.stop("C")["id"])).to_have_attribute("aria-checked", "true")
        self.control("passenger-pickup-open").click()
        self.check_quote("a_to_b", "C", "D", 1)
        self.passed("Same/backward stops are disabled and changing destination invalidates the previous quote")

    def narrow_and_reverse(self):
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.control("passenger-pickup-open").click()
        require(self.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "390px stop picker must not overflow")
        self.screenshot("mobile-390-stop-picker")
        self.control("passenger-pickup-open").click()
        self.passed("390px actual passenger stop picker renders without horizontal overflow")
        self.control("passenger-direction-b_to_a").click()
        self.expect(self.control("passenger-pickup-open")).to_contain_text(self.stop("B")["name"])
        self.expect(self.control("passenger-destination-open")).to_contain_text(self.stop("A")["name"])
        self.expect(self.control("route-book-trip")).to_be_disabled()
        self.choose("pickup", "D")
        self.choose("destination", "C")
        self.context.grant_permissions(["geolocation"], origin=self.args.base_url)
        location = self.stop("D")["location"]
        self.context.set_geolocation({"latitude": location["lat"], "longitude": location["lng"], "accuracy": 5})
        self.reverse_fare = self.check_quote("b_to_a", "D", "C", 2)
        self.screenshot("mobile-390-reverse-D-to-C")
        self.passed("Direction change resets B/A endpoints and reverse D-to-C quote uses the B queue")

    def book(self):
        with self.response_for("/orders/route", "POST") as pending:
            self.control("route-book-trip").click()
        response = pending.value
        require(response.status == 201, f"Actual segment booking must succeed, got {response.status}: {self.safe(response.json())}")
        body, result = response.request.post_data_json, response.json()
        require(body["pickup_stop_id"] == self.stop("D")["id"] and body["destination_stop_id"] == self.stop("C")["id"] and body["direction"] == "b_to_a",
            "Order POST must retain the quoted segment")
        require(body["seats"] == 2 and "fare" not in body and "price" not in body, "App must submit seats and selectors without inventing fare")
        location = self.stop("D")["location"]
        require(abs(body["pickup_location"]["lat"] - location["lat"]) < 0.0001 and abs(body["pickup_location"]["lng"] - location["lng"]) < 0.0001,
            "Actual Expo Location must submit emulated GPS at selected stop D")
        order = result["order"]
        self.order_id = order["id"]
        self.successful_request_key = response.request.header_value("Idempotency-Key")
        first_b = next(driver for driver in self.drivers if driver["direction"] == "b_to_a")
        require(order["offered_driver_id"] == first_b["id"], "Real FIFO must select the first driver in the B lane")
        require(order["fare"]["pickupStop"]["id"] == self.stop("D")["id"] and order["fare"]["destinationStop"]["id"] == self.stop("C")["id"], "Persisted order must retain exact selected stops")
        require(order["fare"]["totalKzt"] == self.reverse_fare["totalKzt"], "Persisted fare must match server quote")
        fetched = self.expected(api_request(self.args.api_url, "/orders/" + self.order_id, token=self.passenger_token), 200, "Fetch durable selected-segment order")["order"]
        require(fetched["id"] == self.order_id and fetched["fare"] == order["fare"], "Order must be stored by the actual PostgreSQL runtime")
        self.expect(self.page.get_by_text("Точка подачи: " + self.stop("D")["name"], exact=True)).to_be_visible()
        self.expect(self.page.get_by_text("Куда: " + self.stop("C")["name"], exact=True)).to_be_visible()
        self.screenshot("mobile-390-booked-D-to-C")
        self.passed("Actual passenger POST persists D-to-C GPS, fare and FIFO assignment and displays the real stop names")

    def recover_unsubmitted_booking(self):
        captured = {}
        pattern = "**/api/orders/route"

        def disconnect(route):
            if route.request.method != "POST":
                route.continue_()
                return
            require(not captured, "The app must not automatically retry a booking POST")
            captured["key"] = route.request.header_value("Idempotency-Key")
            captured["body"] = route.request.post_data_json
            self.disconnect_injected = True
            self.recovery_lookup_path = "/api/orders/route/requests/" + captured["key"]
            route.abort("connectionfailed")

        self.page.route(pattern, disconnect)
        try:
            with self.page.expect_event("requestfailed", predicate=lambda request:
                    urlparse(request.url).path == "/api/orders/route" and request.method == "POST"):
                self.control("route-book-trip").click()
        finally:
            self.page.unroute(pattern, disconnect)
        require(bool(re.fullmatch(r"[0-9a-f-]{36}", captured.get("key", ""))), "An actual minted key must identify the interrupted write")
        self.expect(self.control("route-refresh-after-submit")).to_be_visible()
        self.expect(self.control("route-book-trip")).to_be_disabled()
        self.page.reload(wait_until="domcontentloaded")
        self.expect(self.control("route-refresh-after-submit")).to_be_visible()
        self.expect(self.control("route-book-trip")).to_be_disabled()
        path = "/orders/route/requests/" + captured["key"] + "/resolve"
        with self.response_for(path, "POST") as pending:
            self.control("route-refresh-after-submit").click()
        require(pending.value.status == 200 and pending.value.json() == {"state": "closed", "request_key": captured["key"]},
            "Recovery must obtain a real durable closure, not guess from404")
        self.expect(self.control("route-refresh-after-submit")).to_have_count(0)
        self.expect(self.control("route-book-trip")).to_be_disabled()
        orders = self.expected(api_request(self.args.api_url, "/orders", token=self.passenger_token), 200, "Inspect interrupted passenger orders")["orders"]
        require(orders == [], "Transport interruption and resolution must not create a ride")
        late_request = Request(self.args.api_url.rstrip("/") + "/api/orders/route", method="POST",
            data=json.dumps(captured["body"]).encode(), headers={"Content-Type": "application/json",
                "Authorization": "Bearer " + self.passenger_token, "Idempotency-Key": captured["key"]})
        try:
            late_response = urlopen(late_request, timeout=15)
        except HTTPError as error:
            late_response = error
        with late_response:
            late = self.expected((late_response.status, json.loads(late_response.read().decode())),
                409, "Delayed original booking must be fenced")
        require(late.get("error", {}).get("code") == "ORDER_REQUEST_CLOSED", "A delayed original POST must not become another booking")
        self.closed_request_key = captured["key"]
        self.passed("Interrupted actual booking survives reload, resolves through the server fence and rejects its delayed original POST")
        # A new user action must obtain a new quote/key after successful closure.
        self.control("passenger-route-" + self.route["id"]).click()
        self.control("passenger-direction-b_to_a").click()
        self.choose("pickup", "D")
        self.choose("destination", "C")
        self.control("route-seats-plus").click()
        self.reverse_fare = self.check_quote("b_to_a", "D", "C", 2)
        self.expect(self.control("route-book-trip")).to_be_enabled()
        self.passed("Server-confirmed absence allows a fresh explicit quote without reusing the interrupted booking")

    def resolve_committed_booking(self):
        require(bool(self.successful_request_key), "The successful booking must retain its actual request key")
        require(self.successful_request_key != self.closed_request_key, "A replacement booking must mint a new key after durable closure")
        result = self.expected(api_request(self.args.api_url,
            "/orders/route/requests/" + self.successful_request_key + "/resolve", "POST", {}, self.passenger_token),
            200, "Resolve a committed booking")
        require(result.get("state") == "created" and result.get("request_key") == self.successful_request_key and
            result.get("order", {}).get("id") == self.order_id, "Resolution must restore the committed ride without cancelling it")
        orders = self.expected(api_request(self.args.api_url, "/orders", token=self.passenger_token), 200, "Inspect final passenger orders")["orders"]
        require(len(orders) == 1 and orders[0]["id"] == self.order_id and orders[0]["status"] == "searching",
            "Closure/rebooking/recovery must leave exactly one live ride")
        self.passed("Resolving the committed replacement restores exactly one live order without cancellation or another reservation")

    def cleanup(self):
        failures = []
        if self.order_id and self.passenger_token:
            try:
                status, _ = api_request(self.args.api_url, "/orders/" + self.order_id + "/cancel", "POST", token=self.passenger_token)
                if status != 200:
                    failures.append("Booking cancellation returned " + str(status))
            except Exception as error:
                failures.append("Booking cleanup failed: " + type(error).__name__)
        for driver in self.drivers:
            try:
                status, _ = api_request(self.args.api_url, "/queue/leave", "DELETE", token=driver["token"])
                if status != 204:
                    failures.append("Fixture queue cleanup returned " + str(status))
            except Exception as error:
                failures.append("Fixture queue cleanup failed: " + type(error).__name__)
        return failures

    def run(self):
        self.setup()
        self.passenger_login()
        self.forward_and_invalid_selection()
        self.narrow_and_reverse()
        self.recover_unsubmitted_booking()
        self.book()
        self.resolve_committed_booking()
        require(not [entry for entry in self.console if entry["type"] == "error"] and not self.page_errors,
            "Unexpected browser errors: " + str(self.safe(self.console + self.page_errors)))
        require(self.page.locator("vite-error-overlay, nextjs-portal, [data-nextjs-dialog-overlay]").count() == 0, "No framework overlay may cover the actual app")
        self.passed("No unexpected console/page errors or framework overlays")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:4174")
    parser.add_argument("--api-url", default="http://127.0.0.1:5000")
    parser.add_argument("--admin-phone", default=os.environ.get("ADMIN_PHONE"))
    parser.add_argument("--output-dir", type=Path, default=Path("/tmp/passenger-route-stops-qa"))
    args = parser.parse_args()
    require(os.environ.get("NODE_ENV") in {"test", "development"}, "QA requires local nonproduction OTP configuration")
    require(bool(args.admin_phone), "ADMIN_PHONE must match the local API test administrator")
    for origin in (args.base_url, args.api_url):
        parsed = urlparse(origin)
        require(parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"} and parsed.path in {"", "/"}
            and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment, "QA URLs must address local root CI services")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = {"status": "failed", "checks": [], "environment": {"base_url": args.base_url, "api_url": args.api_url,
        "browser": "Chromium / Python Playwright", "viewports": [{"width": 1440, "height": 1000}, {"width": 390, "height": 844}],
        "geolocation": "browser emulation; physical Android/iPhone GPS remains untested"},
        "scope": "Actual configured-route passenger stop selection and booking, real API/PostgreSQL; no response mocks"}
    qa, exit_code = None, 1
    try:
        from playwright.sync_api import expect, sync_playwright
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="ru-RU")
            page = context.new_page()
            page.set_default_timeout(20_000)
            qa = PassengerStopsQA(args, context, page, expect)
            try:
                qa.run()
                report["status"], exit_code = "passed", 0
            except Exception:
                try:
                    qa.screenshot("failure")
                except Exception:
                    pass
                raise
            finally:
                try:
                    failures = qa.cleanup()
                    if failures:
                        report["cleanup_errors"] = failures
                        report["status"], exit_code = "failed", 1
                finally:
                    context.close()
                    browser.close()
    except Exception as error:
        safe = qa.safe if qa else shared.redact
        report["error"] = safe(str(error))
        print(safe(traceback.format_exc()), file=sys.stderr)
    finally:
        safe = qa.safe if qa else shared.redact
        if qa:
            report.update({"checks": qa.checks, "route_id": qa.route["id"] if qa.route else None,
                "order_id": qa.order_id, "page_errors": qa.page_errors, "requests": qa.requests})
            (args.output_dir / "console.log").write_text("\n".join(json.dumps(safe(entry), ensure_ascii=False) for entry in qa.console) + "\n", encoding="utf-8")
        report["screenshots"] = sorted(file.name for file in args.output_dir.glob("*.png"))
        (args.output_dir / "verification.json").write_text(json.dumps(safe(report), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
