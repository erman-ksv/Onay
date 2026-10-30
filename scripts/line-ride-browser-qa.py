#!/usr/bin/env python3
"""Verify an actual Expo line ride and the next enrollment against local PostgreSQL.

Two isolated browsers authenticate through the real UI and use the existing local
development OTP response. Only browser GPS is emulated; HTTP, dispatch, queue
receipts and storage are real. This is not physical Android/iPhone acceptance.
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


class LineRideQA(shared.DriverRouteQA):
    def __init__(self, args, driver_context, driver_page, passenger_context, passenger_page, expect):
        self.secrets = set()
        super().__init__(args, driver_context, driver_page, expect)
        self.passenger_context, self.passenger_page = passenger_context, passenger_page
        self.passenger_token = self.order_id = self.route = self.enrollment_id = None
        self.capacity_snapshots = []
        self.last_driver_gps_at = None
        self.history_abort_observed = False
        passenger_page.on("console", self.on_console)
        passenger_page.on("pageerror", lambda error: self.page_errors.append(self.safe(str(error))))
        passenger_page.on("request", self.on_request)
        passenger_page.on("response", self.on_response)
        passenger_page.on("dialog", lambda dialog: dialog.accept())

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
        if message.type in {"warning", "error"}:
            self.console.append({"type": message.type, "text": self.safe(message.text), "url": message.location.get("url", "")})

    def on_request(self, request):
        parsed = urlparse(request.url)
        if parsed.path.startswith("/api/"):
            # Authentication bodies, headers and session payloads never enter artifacts.
            self.requests.append({"path": parsed.path, "method": request.method})

    def expected(self, result, status, description):
        actual, body = result
        require(actual == status, f"{description}: expected HTTP {status}, got {actual}: {self.safe(body)}")
        return body

    def response(self, page, pathname, method):
        return page.expect_response(lambda result:
            urlparse(result.url).path == "/api" + pathname and result.request.method == method,
            timeout=20_000)

    def shot(self, page, name):
        page.screenshot(path=str(self.args.output_dir / (name + ".png")), full_page=True,
            mask=[page.get_by_placeholder("Код подтверждения", exact=True),
                  page.get_by_text(re.compile(r"Тестовый код:")),
                  page.get_by_test_id("passenger-driver-phone")])

    def screenshot(self, name):
        self.shot(self.page, name + "-driver")
        self.shot(self.passenger_page, name + "-passenger")

    def stop(self, code):
        return next(stop for stop in self.route["stops"] if stop["code"] == code)

    def gps(self, context, code):
        location = self.stop(code)["location"]
        context.grant_permissions(["geolocation"], origin=self.args.base_url)
        context.set_geolocation({"latitude": location["lat"], "longitude": location["lng"], "accuracy": 5})

    def setup(self):
        self.expected(api_request(self.args.api_url, "/healthz"), 200, "Local API health")
        body = {"phone_number": self.args.admin_phone, "full_name": "CI line ride admin", "role": "admin", "locale": "ru"}
        # The two preceding QAs already used this administrator. Honor one real
        # cooldown only; never rotate identity, bypass the limiter or rerun a task.
        for attempt in range(2):
            request = Request(self.args.api_url.rstrip("/") + "/api/auth/request-otp",
                data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
            try:
                response = urlopen(request, timeout=15)
            except HTTPError as error:
                response = error
            with response:
                status, value = response.status, json.loads(response.read().decode())
                retry_after = response.headers.get("Retry-After", "")
            if status != 429 or attempt == 1:
                challenge = self.expected((status, value), 202, "Administrator OTP request")
                break
            require(re.fullmatch(r"\d+", retry_after) is not None, "OTP cooldown must supply numeric Retry-After")
            seconds = int(retry_after)
            require(0 < seconds <= 60, "OTP cooldown exceeds the single bounded 60-second wait")
            print("Waiting for the administrator OTP cooldown:", seconds, "seconds", flush=True)
            time.sleep(seconds)
        code = self.remember(challenge.get("demo_code", ""))
        require(bool(re.fullmatch(r"\d{6}", code)), "Local nonproduction OTP must supply the administrator code")
        session = self.expected(api_request(self.args.api_url, "/auth/verify-otp", "POST",
            {"phone_number": self.args.admin_phone, "code": code}), 200, "Administrator OTP verification")
        self.admin_token = self.remember(session["access_token"])
        require(session.get("user", {}).get("role") == "admin", "Setup must authenticate the real administrator")
        created = self.expected(api_request(self.args.api_url, "/admin/routes", "POST", {
            "name": "QA линия полный рейс " + uuid.uuid4().hex[:10], "active": True, "currency": "UZS", "price_per_stop": 2500,
        }, self.admin_token), 201, "Create configured line route")["route"]
        self.route = self.expected(api_request(self.args.api_url, "/admin/routes/" + created["id"] + "/layout", "PUT", {
            "expected_updated_at": created["updatedAt"],
            # Distinct A/C/B points span approximately 55.6 meters. This keeps
            # real elapsed UI time compatible with the unmodified speed guard.
            "stops": [{"code": code, "name": "QA линия " + code,
                "location": {"lat": 42.9 + index * 0.00025, "lng": 71.3}}
                for index, code in enumerate(("A", "C", "B"))],
            "pitaks": {"a_stop_code": "A", "b_stop_code": "B", "radius_meters": 175},
        }, self.admin_token), 200, "Persist short real A/C/B route")["route"]
        self.routes = [self.route]
        require([stop["code"] for stop in self.route["stops"]] == ["A", "C", "B"], "Configured route must retain A/C/B order")
        self.passed("Real administrator OTP configures a short A/C/B line in PostgreSQL")

    def ui_login(self, page, role):
        page.goto(self.args.base_url, wait_until="domcontentloaded")
        page.get_by_role("button", name="Водитель" if role == "driver" else "Пассажир", exact=True).click()
        page.get_by_test_id("auth-signup-mode").click()
        page.get_by_placeholder("Имя", exact=True).fill("CI line ride")
        page.get_by_placeholder("Фамилия", exact=True).fill(role)
        page.get_by_placeholder("+998 90 123 45 67", exact=True).fill(
            "+77776" + str(uuid.uuid4().int % 1_000_000).zfill(6))
        with self.response(page, "/auth/request-otp", "POST") as pending:
            page.get_by_role("button", name="Получить код", exact=True).click()
        require(pending.value.status == 202, "Actual " + role + " screen must request OTP")
        code = self.remember(pending.value.json().get("demo_code", ""))
        require(bool(re.fullmatch(r"\d{6}", code)), "Actual local UI must receive its development OTP")
        page.get_by_placeholder("Код подтверждения", exact=True).fill(code)
        with self.response(page, "/auth/verify-otp", "POST") as pending:
            page.get_by_role("button", name="Продолжить как водитель" if role == "driver" else "Войти как пассажир", exact=True).click()
        require(pending.value.status == 200, "Actual " + role + " screen must verify OTP")
        session = pending.value.json()
        token = self.remember(session["access_token"])
        user = session["user"]
        require(user.get("active_role", user.get("role")) == role, "UI must authenticate the selected role")
        return token, user

    def authenticate(self):
        self.driver_token, driver = self.ui_login(self.page, "driver")
        self.driver_id = driver["id"]
        self.expected_driver = {key: driver[key] for key in ("id", "full_name", "phone_number")}
        require(driver.get("driver_approval_status") == "pending", "New driver must require actual administrator approval")
        self.expect(self.page.get_by_text("Профиль на проверке", exact=True)).to_be_visible()
        self.expect(self.control("driver-line-join")).to_have_count(0)
        for field, value in (("make", "Chevrolet"), ("model", "Cobalt"), ("plate", "01 A123 BC"), ("seats", "3")):
            self.control("driver-vehicle-" + field).fill(value)
        with self.response_for("/driver/vehicle", "PUT") as pending:
            self.control("driver-vehicle-save").click()
        require(pending.value.status == 200, "Actual driver vehicle form must persist its profile")
        profile = pending.value.json()
        require(profile.get("approval_status") == "pending", "New vehicle must require review")
        vehicle = profile["driver_vehicle"]
        require(pending.value.request.post_data_json["expected_revision"] is None, "First profile save must bind an absent receipt")
        self.expected_driver["vehicle"] = {key: vehicle[key] for key in ("make", "model", "plate_number", "seat_capacity")}
        self.expected(api_request(self.args.api_url, "/admin/drivers/" + self.driver_id + "/approval", "PATCH",
            {"status": "approved", "expected_vehicle_revision": vehicle["revision"]}, self.admin_token), 200, "Approve the actual reviewed driver vehicle")
        with self.response_for("/auth/me", "GET") as pending:
            self.page.get_by_role("button", name="Проверить статус", exact=True).click()
        require(pending.value.status == 200, "Actual driver must refresh approval")
        self.expect(self.control("driver-route-picker")).to_be_visible()
        self.identity()
        self.passenger_token, _ = self.ui_login(self.passenger_page, "passenger")
        self.expect(self.passenger_page.get_by_test_id("configured-route-passenger")).to_be_visible()
        require(self.context != self.passenger_context, "Driver and passenger must have isolated browser sessions")
        self.passed("Two isolated Expo sessions perform actual OTP login and driver administrator approval")
        with self.response_for("/orders", "GET") as pending:
            self.control("driver-history-toggle").click()
        require(pending.value.status == 200, "History must use an actual authorized order read")
        self.expect(self.control("driver-history-empty")).to_be_visible()
        self.expect(self.control("driver-history-totals")).to_contain_text("Завершено поездок: 0")
        self.expect(self.passenger_page.get_by_test_id("driver-history")).to_have_count(0)
        self.passed("Task4.14 real empty driver history stays separate from passenger UI")

    def queue(self, label=None, seats=None, phase=None):
        snapshot = self.expected(api_request(self.args.api_url, "/queue", token=self.driver_token), 200, "Read actual driver queue")
        if seats is not None:
            entry = snapshot.get("your_entry")
            require(isinstance(entry, dict), "Expected a retained real queue enrollment")
            require(entry.get("availableSeats") == seats, f"{label}: expected {seats} free seats, got {entry.get('availableSeats')}")
            line = entry.get("collectionState", {})
            require(line.get("capacity") == 3, "Enrollment capacity must remain three")
            require(line.get("enrollmentId") == self.enrollment_id, "Lifecycle must retain its opaque enrollment receipt")
            if phase:
                require(line.get("phase") == phase, label + ": unexpected server line phase")
            self.capacity_snapshots.append({"stage": label, "available_seats": seats, "capacity": line["capacity"], "phase": line["phase"]})
        return snapshot

    def join(self, direction):
        code = "A" if direction == "a_to_b" else "B"
        self.gps(self.context, code)
        with self.response_for("/queue/line", "POST") as pending:
            self.control("driver-line-join").click()
        response = pending.value
        require(response.status == 201, "Actual line join must return a persisted enrollment")
        body = response.request.post_data_json
        require(body["available_seats"] == 3 and body["route_choice"] == {
            "route_id": self.route["id"], "direction": direction, "expected_updated_at": self.route["updatedAt"],
        }, "Actual join must submit three seats and the saved route version")
        location = body["location"]
        require(abs(location["lat"] - self.stop(code)["location"]["lat"]) < 0.00001 and
            abs(location["lng"] - self.stop(code)["location"]["lng"]) < 0.00001, "Actual Expo Location must use the selected pitak")
        require(location.get("isMocked") is False and abs(location["timestamp"] - time.time() * 1_000) < 30_000,
            "Actual Expo must supply a fresh browser GPS timestamp without forged dates or mocked-coordinate flags")
        self.last_driver_gps_at = time.monotonic()
        result = response.json()
        entry = result["entry"]
        require(result.get("position") == 1 and entry["routeContext"]["pitak"] == code, "New enrollment must enter the correct FIFO lane first")
        self.enrollment_id = entry["collectionState"]["enrollmentId"]
        require(bool(self.enrollment_id), "Enrollment receipt must come from the server")
        self.expect(self.control("driver-queue-context")).to_contain_text("питак " + code)
        self.expect(self.control("driver-route-save")).to_be_disabled()
        self.expect(self.page.get_by_text(re.compile(r"Заказы для этого маршрута пока недоступны"))).to_have_count(0)
        self.expect(self.control("driver-vehicle-save")).to_be_disabled()
        self.queue("joined-" + code, 3, "collecting")

    def join_forward(self):
        self.select_draft(self.route, "a_to_b")
        self.save(self.route, "a_to_b")
        self.join("a_to_b")
        self.screenshot("desktop-line-collecting")
        self.passed("Actual driver saves A-to-B and starts a three-seat line with the current availability hint")

    def assert_leave_protected(self):
        self.expect(self.control("driver-queue-leave")).to_be_disabled()
        status, body = api_request(self.args.api_url, "/queue/leave", "DELETE", token=self.driver_token)
        require(status == 409 and body.get("error", {}).get("code") == "ACTIVE_ORDER",
            "Server must reject leaving during an active offer or ride with ACTIVE_ORDER")

    def book_and_offer(self):
        page = self.passenger_page
        self.gps(self.passenger_context, "A")
        page.get_by_test_id("passenger-route-" + self.route["id"]).click()
        self.expect(page.get_by_test_id("passenger-pickup-open")).to_contain_text(self.stop("A")["name"])
        self.expect(page.get_by_test_id("passenger-destination-open")).to_contain_text(self.stop("B")["name"])
        with self.response(page, "/orders/route/availability", "GET") as pending:
            page.get_by_test_id("route-check-availability").click()
        quote = pending.value
        require(quote.status == 200 and quote.json().get("available") is True and quote.json().get("eligible_driver_count") == 1,
            "Real configured A queue must be available to this passenger")
        query = parse_qs(urlparse(quote.url).query)
        require(query.get("seats") == ["1"] and query.get("direction") == ["a_to_b"], "Passenger must request one seat in the forward direction")
        with self.response(page, "/orders/route", "POST") as pending:
            page.get_by_test_id("route-book-trip").click()
        response = pending.value
        require(response.status == 201, "Actual passenger must create the configured order")
        body, order = response.request.post_data_json, response.json()["order"]
        self.order_id = order["id"]
        require(body["pickup_stop_id"] == self.stop("A")["id"] and body["destination_stop_id"] == self.stop("B")["id"] and body["seats"] == 1,
            "Actual passenger booking must bind the quoted A/B stops and one seat")
        require(order.get("offered_driver_id") == self.driver_id and order["status"] == "searching", "Real FIFO must offer the booking to the line driver")
        self.expect(self.control("driver-incoming-order")).to_be_visible()
        self.expect(page.get_by_test_id("passenger-trip-" + self.order_id)).to_contain_text("Ждём ответа водителя")
        self.expect(page.get_by_test_id("passenger-driver-card")).to_have_count(0)
        self.expected(api_request(self.args.api_url, "/orders/" + self.order_id + "/driver", token=self.passenger_token), 404, "Driver contact stays private before acceptance")
        self.queue("offer-seat-lock", 2, "collecting")
        self.assert_leave_protected()
        self.passed("Actual one-seat passenger booking reaches the FIFO driver, reserves one seat and protects enrollment")

    def passenger_status(self, label):
        self.expect(self.passenger_page.get_by_test_id("passenger-trip-" + self.order_id)).to_contain_text(label)

    def progress(self, status):
        with self.response_for("/orders/" + self.order_id + "/status", "PATCH") as pending:
            self.control("driver-trip-progress-" + self.order_id).click()
        response = pending.value
        require(response.status == 200 and response.json()["order"]["status"] == status,
            "Actual driver progress must persist " + status)
        require(response.request.post_data_json == {"status": status}, "Actual UI must submit the selected next status")

    def accept_and_arrive(self):
        with self.response_for("/orders/" + self.order_id + "/accept", "POST") as pending:
            self.control("driver-order-accept").click()
        require(pending.value.status == 200 and pending.value.json()["order"]["status"] == "en_route_to_c", "Actual driver must accept the offer")
        self.expect(self.control("driver-trip-" + self.order_id)).to_be_visible()
        self.passenger_status("Водитель едет к точке подачи")
        self.expect(self.passenger_page.get_by_test_id("passenger-driver-name")).to_have_text(self.expected_driver["full_name"])
        self.expect(self.passenger_page.get_by_test_id("passenger-driver-phone")).to_contain_text(self.expected_driver["phone_number"])
        actual = self.expected(api_request(self.args.api_url, "/orders/" + self.order_id + "/driver", token=self.passenger_token), 200, "Assigned passenger reads minimal driver contact")
        require(actual == {"driver": self.expected_driver}, "Contact response must contain only the actual assigned driver fields")
        self.expected(api_request(self.args.api_url, "/orders/" + self.order_id + "/driver", token=self.driver_token), 403, "Driver role cannot call the passenger contact endpoint")
        self.expect(self.passenger_page.get_by_test_id("passenger-driver-vehicle")).to_contain_text("Chevrolet Cobalt")
        self.expect(self.passenger_page.get_by_test_id("passenger-driver-vehicle")).to_contain_text("01 A123 BC")
        self.queue("accepted-no-second-charge", 2, "collecting")
        self.progress("arrived_at_c")
        self.passenger_status("Водитель прибыл")
        self.queue("arrived-no-release", 2, "collecting")
        self.assert_leave_protected()
        self.passed("Actual accept and arrival update both apps without charging or releasing the reserved seat again")

    def board_and_cancel_confirmation(self):
        card = self.control("driver-trip-" + self.order_id)
        with self.response_for("/orders/" + self.order_id + "/board", "POST") as pending:
            card.get_by_test_id("driver-line-board").click()
        require(pending.value.status == 200 and pending.value.json()["order"]["status"] == "boarded_waiting", "Actual boarding must persist boarded_waiting")
        self.passenger_status("Ты в машине. Ожидаем отправления водителя")
        self.expect(self.passenger_page.get_by_test_id("passenger-driver-name")).to_have_text(self.expected_driver["full_name"])
        self.queue("boarded-no-release", 2, "collecting")
        before = len([item for item in self.requests if item["path"] == "/api/queue/depart" and item["method"] == "POST"])
        self.control("driver-line-depart").click()
        self.expect(self.control("driver-line-depart-confirm")).to_be_visible()
        self.control("driver-line-depart-cancel").click()
        self.expect(self.control("driver-line-depart-confirm")).to_have_count(0)
        after = len([item for item in self.requests if item["path"] == "/api/queue/depart" and item["method"] == "POST"])
        require(after == before, "Cancelling inline confirmation must not send a departure mutation")
        self.queue("departure-cancelled", 2, "collecting")
        self.passed("Actual boarding waits for departure; cancelling inline confirmation sends no departure request")

    def depart(self):
        self.control("driver-line-depart").click()
        with self.response_for("/queue/depart", "POST") as pending:
            self.control("driver-line-depart-confirm").click()
        response = pending.value
        require(response.status == 200 and response.request.post_data_json == {"expected_enrollment_id": self.enrollment_id},
            "Inline confirmation must submit the actual opaque enrollment receipt")
        orders = response.json().get("orders", [])
        require(any(order["id"] == self.order_id and order["status"] == "in_transit" for order in orders), "Departure must transition the boarded passenger")
        self.passenger_status("Поездка началась")
        self.expect(self.passenger_page.get_by_test_id("passenger-driver-phone")).to_contain_text(self.expected_driver["phone_number"])
        self.expect(self.control("driver-trip-" + self.order_id)).to_contain_text("Поездка началась")
        snapshot = self.queue("departed-no-release", 2, "departed")
        require(snapshot.get("your_position") is None, "Departed line must leave FIFO without deleting its enrollment")
        self.assert_leave_protected()
        for page in (self.page, self.passenger_page):
            page.set_viewport_size({"width": 390, "height": 844})
            require(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "390px actual ride screen must not overflow horizontally")
        self.screenshot("mobile-390-in-transit")
        self.passed("Confirmed departure starts the real trip, leaves FIFO, retains the enrollment and keeps one seat reserved")

    def complete(self):
        self.progress("completed")
        self.expect(self.control("driver-trip-" + self.order_id)).to_have_count(0)
        self.expect(self.passenger_page.get_by_test_id("passenger-trip-" + self.order_id)).to_have_count(0)
        self.expect(self.passenger_page.get_by_text(re.compile(r"QA линия A.*QA линия B: Поездка завершена"))).to_be_visible()
        self.expect(self.passenger_page.get_by_test_id("passenger-driver-card")).to_have_count(0)
        self.expected(api_request(self.args.api_url, "/orders/" + self.order_id + "/driver", token=self.passenger_token), 404, "Completed ride no longer exposes driver contact")
        snapshot = self.queue("completed-capacity-restored", 3, "departed")
        entry = snapshot["your_entry"]
        require(not entry.get("activeOrderIds") and not entry.get("currentOrderId") and not entry.get("pendingOfferOrderId"),
            "Completed enrollment must contain no active ride or offer")
        order = self.expected(api_request(self.args.api_url, "/orders/" + self.order_id, token=self.passenger_token), 200, "Read durable completed order")["order"]
        require(order["status"] == "completed", "Passenger-authorized read must confirm durable completion")
        status, body = api_request(self.args.api_url, "/orders/" + self.order_id + "/status", "PATCH",
            {"status": "completed"}, self.driver_token)
        require(status == 409 and body.get("error", {}).get("code") == "INVALID_STATUS_TRANSITION",
            "Repeating completion must reject the closed-order transition")
        self.queue("repeated-completion-no-extra-release", 3, "departed")
        self.passed("Actual completion reaches passenger history and restores exactly the three-seat capacity")
        self.expected_history_fare = order["fare"]["total"]
        require(order["fare"]["currency"] == "UZS" and self.expected_history_fare == 5000, "Completed work must retain the real two-stop frozen UZS fare")
        with self.response_for("/orders", "GET") as pending:
            self.control("driver-history-refresh").click()
        require(pending.value.status == 200, "History refresh must read real persisted completed orders")
        row = self.control("driver-history-row-" + self.order_id)
        self.expect(row).to_contain_text("Поездка завершена")
        self.expect(row).to_contain_text("QA линия A → QA линия B")
        self.expect(self.control("driver-history-totals")).to_contain_text("Завершено поездок: 1")
        self.expect(self.control("driver-history-totals")).to_contain_text(re.compile(r"5\s000 сум"))
        self.expect(self.control("driver-history-empty")).to_have_count(0)
        self.page.set_viewport_size({"width": 390, "height": 844})
        require(self.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "390px history must fit without horizontal overflow")
        self.shot(self.page, "task4-14-history-mobile-390")
        self.page.set_viewport_size({"width": 1440, "height": 1000})
        self.shot(self.page, "task4-14-history-desktop")
        self.passed("Task4.14 actual completed driver work shows frozen UZS sum and route on desktop and390px")

    def close_retained_enrollment(self):
        with self.response_for("/queue", "GET") as pending:
            self.page.reload(wait_until="domcontentloaded")
        snapshot = pending.value.json()
        require(pending.value.status == 200 and snapshot.get("your_position") is None and snapshot.get("your_entry") is not None,
            "Reload must distinguish null FIFO position from a retained enrollment")
        self.expect(self.control("driver-vehicle-plate")).to_have_value("01 A123 BC")
        self.queue("reloaded-finished-no-extra-release", 3, "departed")
        self.expect(self.control("driver-line-finished")).to_be_visible()
        leave = self.control("driver-queue-leave")
        self.expect(leave).to_be_enabled()
        self.expect(leave).to_contain_text("Завершить рейс и выйти с линии")
        self.expect(self.control("driver-queue-join")).to_have_count(0)
        self.expect(self.control("driver-line-join")).to_have_count(0)
        self.expect(self.control("driver-route-save")).to_be_disabled()
        self.expect(self.control("driver-direction-b_to_a")).to_be_disabled()
        self.shot(self.page, "mobile-390-finished-retained-enrollment")
        with self.response_for("/queue/leave", "DELETE") as pending:
            leave.click()
        require(pending.value.status == 204, "Actual close control must DELETE the finished enrollment")
        snapshot = self.queue()
        require(snapshot.get("your_entry") is None and snapshot.get("your_position") is None, "Only acknowledged DELETE must clear membership")
        self.expect(self.control("driver-line-finished")).to_have_count(0)
        self.expect(self.control("driver-line-join")).to_be_enabled()
        self.expect(self.control("driver-route-save")).to_be_enabled()
        self.passed("Reload retains the finished enrollment; only explicit successful close unlocks route selection and rejoining")

    def join_reverse(self):
        previous = self.enrollment_id
        self.select_draft(self.route, "b_to_a")
        self.save(self.route, "b_to_a")
        # Real elapsed time, never manufactured coordinate timestamps. Even the
        # short fixture must respect the production 180 km/h speed check.
        distance_m = abs(self.stop("B")["location"]["lat"] - self.stop("A")["location"]["lat"]) * math.pi * 6_371_000 / 180
        wait = max(0, distance_m / 50 + 1 - (time.monotonic() - self.last_driver_gps_at))
        require(wait <= 3, "Short-route fixture unexpectedly requires a long GPS wait")
        if wait:
            time.sleep(wait)
        self.join("b_to_a")
        require(self.enrollment_id != previous, "Opposite-direction enrollment must receive a fresh server receipt")
        self.expect(self.control("driver-queue-status")).to_contain_text("позиция 1")
        self.assert_stops(self.route, "b_to_a")
        self.shot(self.page, "mobile-390-new-B-to-A-enrollment")
        for page in (self.page, self.passenger_page):
            require(page.locator("vite-error-overlay, nextjs-portal, [data-nextjs-dialog-overlay]").count() == 0, "Actual app must have no framework error overlay")
        require(not [entry for entry in self.console if entry["type"] == "error"] and not self.page_errors,
            "Unexpected browser errors: " + str(self.safe(self.console + self.page_errors)))
        self.passed("Actual driver saves B-to-A and joins pitak B with fresh FIFO receipt/capacity and healthy desktop/mobile apps")

    def history_recovery(self):
        if self.control("driver-history-toggle").inner_text() == "Показать историю":
            self.control("driver-history-toggle").click()
        self.expect(self.control("driver-history-totals")).to_contain_text("Завершено поездок: 1")
        self.expect(self.control("driver-history-totals")).to_contain_text(re.compile(r"5\s000 сум"))
        self.passed("Task4.14 real completed earnings survive app reload and new enrollment without double counting")
        def fail_transport(route):
            self.history_abort_observed = True
            route.abort("failed")
        self.page.route("**/api/orders", fail_transport)
        self.control("driver-history-refresh").click()
        self.expect(self.control("driver-history-error")).to_be_visible()
        self.expect(self.control("driver-history-totals")).to_have_count(0)
        self.expect(self.control("driver-history-row-" + self.order_id)).to_have_count(0)
        self.expect(self.control("driver-history-empty")).to_have_count(0)
        self.shot(self.page, "task4-14-history-transport-error")
        self.page.unroute("**/api/orders", fail_transport)
        with self.response_for("/orders", "GET") as pending:
            self.control("driver-history-refresh").click()
        require(pending.value.status == 200, "Explicit history retry must recover the real PostgreSQL snapshot")
        self.expect(self.control("driver-history-row-" + self.order_id)).to_be_visible()
        self.expect(self.control("driver-history-error")).to_have_count(0)
        self.expect(self.control("driver-history-totals")).to_contain_text(re.compile(r"5\s000 сум"))
        unexpected = [entry for entry in self.console if entry["type"] == "error" and not (
            self.history_abort_observed and urlparse(entry.get("url", "")).path == "/api/orders" and
            entry["text"] == "Failed to load resource: net::ERR_FAILED")]
        require(not unexpected and not self.page_errors, "Unexpected history browser errors: " + str(self.safe(unexpected + self.page_errors)))
        self.passed("Task4.14 real transport failure clears stale history and totals, differs from empty, explicit retry recovers without browser errors")

    def cleanup(self):
        failures = []
        if self.order_id and self.passenger_token:
            try:
                order = self.expected(api_request(self.args.api_url, "/orders/" + self.order_id, token=self.passenger_token), 200, "Read own order for cleanup")["order"]
                if order["status"] not in {"completed", "cancelled"}:
                    self.expected(api_request(self.args.api_url, "/orders/" + self.order_id + "/cancel", "POST", token=self.passenger_token), 200, "Cancel own unfinished fixture order")
            except Exception as error:
                failures.append("Order cleanup: " + self.safe(str(error)))
        if self.driver_token:
            try:
                snapshot = self.queue()
                if snapshot.get("your_entry") is not None:
                    self.expected(api_request(self.args.api_url, "/queue/leave", "DELETE", token=self.driver_token), 204, "Leave own fixture enrollment")
                require(self.queue().get("your_entry") is None, "Fixture enrollment must be removed")
            except Exception as error:
                failures.append("Queue cleanup: " + self.safe(str(error)))
        return failures

    def run(self):
        self.setup()
        self.authenticate()
        self.join_forward()
        self.book_and_offer()
        self.accept_and_arrive()
        self.board_and_cancel_confirmation()
        self.depart()
        self.complete()
        self.close_retained_enrollment()
        self.join_reverse()
        self.history_recovery()
        require(len(self.checks) == 14, "Ten original line checks plus four Task4.14 history checks must complete")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:4174")
    parser.add_argument("--api-url", default="http://127.0.0.1:5000")
    parser.add_argument("--admin-phone", default=os.environ.get("ADMIN_PHONE"))
    parser.add_argument("--output-dir", type=Path, default=Path("/tmp/line-ride-qa"))
    args = parser.parse_args()
    require(os.environ.get("NODE_ENV") in {"test", "development"}, "QA requires local nonproduction OTP configuration")
    require(bool(args.admin_phone), "ADMIN_PHONE must match the local API administrator")
    for origin in (args.base_url, args.api_url):
        parsed = urlparse(origin)
        require(parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"} and parsed.path in {"", "/"}
            and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment, "QA URLs must address local root services")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = {"status": "failed", "checks": [], "environment": {"base_url": args.base_url, "api_url": args.api_url,
        "browser": "Chromium / Python Playwright", "isolated_sessions": 2,
        "viewports": [{"width": 1440, "height": 1000}, {"width": 390, "height": 844}],
        "geolocation": "browser emulation with real timestamps; physical Android/iPhone GPS remains untested"},
        "scope": "Actual Expo one-seat A/B line ride, retained membership closure and new reverse enrollment; real API/PostgreSQL, no HTTP mocks"}
    qa, exit_code = None, 1
    try:
        from playwright.sync_api import expect, sync_playwright
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            driver_context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="ru-RU")
            passenger_context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="ru-RU")
            driver_page, passenger_page = driver_context.new_page(), passenger_context.new_page()
            for page in (driver_page, passenger_page):
                page.set_default_timeout(20_000)
            qa = LineRideQA(args, driver_context, driver_page, passenger_context, passenger_page, expect)
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
                    report["cleanup"] = "failed" if failures else "passed"
                    if failures:
                        report["cleanup_errors"] = failures
                        report["status"], exit_code = "failed", 1
                finally:
                    driver_context.close()
                    passenger_context.close()
                    browser.close()
    except Exception as error:
        safe = qa.safe if qa else shared.redact
        report["error"] = safe(str(error))
        print(safe(traceback.format_exc()), file=sys.stderr)
    finally:
        safe = qa.safe if qa else shared.redact
        if qa:
            report.update({"checks": qa.checks, "route_id": qa.route["id"] if qa.route else None,
                "order_id": qa.order_id, "driver_id": qa.driver_id, "page_errors": qa.page_errors,
                "requests": qa.requests, "responses": qa.responses, "capacity_snapshots": qa.capacity_snapshots})
            (args.output_dir / "console.log").write_text("\n".join(json.dumps(safe(entry), ensure_ascii=False) for entry in qa.console) + "\n", encoding="utf-8")
        report["screenshots"] = sorted(file.name for file in args.output_dir.glob("*.png"))
        (args.output_dir / "verification.json").write_text(json.dumps(safe(report), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())

