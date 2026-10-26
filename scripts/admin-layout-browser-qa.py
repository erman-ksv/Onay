#!/usr/bin/env python3
"""Real admin layout QA against the CI API/PostgreSQL and compiled admin UI.

Browser plugin not available; this explicit CI task uses Python Playwright.
API responses are not mocked. The journal recovery check deliberately aborts one transport request; retry uses the real API. CI's nonproduction NODE_ENV exposes the existing
development OTP response; production credentials or OTP bypasses are not used.
"""

import argparse
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
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def redact(value):
    if isinstance(value, dict):
        return {
            key: "[redacted]" if key.lower() in {"access_token", "authorization", "demo_code"} or (key.lower() == "code" and isinstance(item, str) and re.fullmatch(r"\d{6}", item)) else redact(item)
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


class AdminLayoutQA:
    def __init__(self, args, page, expect):
        self.args, self.page, self.expect = args, page, expect
        self.checks = []
        self.console = []
        self.page_errors = []
        self.layout_requests = []
        self.map_tiles = []
        self.map_selections = []
        self.expected_coordinates = {"A": (42.9, 71.3), "C": (42.91, 71.34), "B": (42.94, 71.43)}
        self.expected_conflict_path = None
        self.conflict_observed = False
        self.vehicle_conflict_path = None
        self.vehicle_conflict_observed = False
        self.order_conflict_paths = set()
        self.order_network_failure_path = None
        self.order_cancel_requests = []
        self.audit_network_failure = False
        self.monitor_network_failure = False
        self.admin_requests = []
        self.token = None
        self.route_id = None
        self.last_otp_accepted_at = None
        page.on("console", self.on_console)
        page.on("pageerror", lambda error: self.page_errors.append(redact(str(error))))
        page.on("request", self.on_request)
        page.on("response", self.on_response)
        page.on("requestfailed", self.on_request_failed)

    @staticmethod
    def is_map_tile(url):
        parsed = urlparse(url)
        return parsed.hostname == "tile.openstreetmap.org" and bool(re.fullmatch(r"/\d+/\d+/\d+\.png", parsed.path))

    def on_response(self, response):
        if self.is_map_tile(response.url):
            self.map_tiles.append({"url": response.url, "status": response.status})

    def on_request_failed(self, request):
        if self.is_map_tile(request.url):
            self.map_tiles.append({"url": request.url, "failure": redact(request.failure)})

    def on_request(self, request):
        if urlparse(request.url).path.startswith("/api/admin/"):
            self.admin_requests.append({"method": request.method, "path": urlparse(request.url).path, "query": urlparse(request.url).query})
        if request.method == "POST" and re.fullmatch(r"/api/admin/orders/[^/]+/cancel", urlparse(request.url).path):
            self.order_cancel_requests.append(urlparse(request.url).path)
        if request.method == "PUT" and urlparse(request.url).path.endswith("/layout"):
            self.layout_requests.append(urlparse(request.url).path)

    def on_console(self, message):
        self.console.append({"type": message.type, "text": redact(message.text), "url": message.location.get("url", "")})

    def passed(self, name):
        self.checks.append({"name": name, "status": "passed"})
        print("PASS:", name, flush=True)

    def response_for(self, pathname, method):
        return self.page.expect_response(
            lambda response: urlparse(response.url).path == "/api" + pathname and response.request.method == method,
            timeout=15_000,
        )

    def screenshot(self, name):
        self.page.screenshot(path=str(self.args.output_dir / (name + ".png")), full_page=True)

    def identity(self):
        require(urlparse(self.page.url).path.rstrip("/") == "/admin", "Browser must remain on the actual /admin page")
        self.expect(self.page).to_have_title("TezJet — администрирование")
        self.expect(self.page.locator("#root")).not_to_be_empty()
        require(self.page.locator("vite-error-overlay, nextjs-portal, [data-nextjs-dialog-overlay]").count() == 0, "Framework error overlay is visible")

    def wait_for_otp_cooldown(self):
        if self.last_otp_accepted_at is None:
            return
        cooldown_seconds = int(os.environ.get("TEZJET_OTP_RESEND_SECONDS", "60"))
        remaining = self.last_otp_accepted_at + cooldown_seconds - time.monotonic()
        if remaining > 0:
            print(f"Waiting {remaining:.1f}s for the actual OTP resend interval", flush=True)
            time.sleep(remaining + 0.05)

    def login(self):
        self.expect(self.page.get_by_role("heading", name="Вход в панель", exact=True)).to_be_visible()
        self.page.get_by_label("Телефон администратора", exact=True).fill(self.args.admin_phone)
        self.page.get_by_label("Имя", exact=True).fill("CI administrator")
        # Reload tests reuse this administrator and respect the same cooldown
        # as the real API. The fixture never resets or disables OTP limits.
        self.wait_for_otp_cooldown()
        with self.response_for("/auth/request-otp", "POST") as pending:
            self.page.get_by_role("button", name="Получить код", exact=True).click()
        response = pending.value
        require(response.status == 202, "UI OTP request must be accepted by the real server")
        self.last_otp_accepted_at = time.monotonic()
        challenge = response.json()
        code = challenge.get("demo_code", "")
        require(bool(re.fullmatch(r"\d{6}", code)), "Existing test-only OTP must be returned; no auth bypass is permitted")
        self.expect(self.page.get_by_text("Тестовый код разработки:", exact=False)).to_be_visible()
        self.page.get_by_label("Код подтверждения", exact=True).fill(code)
        with self.response_for("/auth/verify-otp", "POST") as pending:
            self.page.get_by_role("button", name="Войти", exact=True).click()
        response = pending.value
        require(response.status == 200, "UI OTP verification must succeed")
        session = response.json()
        require(session.get("user", {}).get("role") == "admin", "UI session must belong to a real admin")
        self.token = session["access_token"]
        self.expect(self.page.get_by_role("button", name="Выйти", exact=True)).to_be_visible()
        self.identity()

    def open_routes(self):
        self.page.get_by_role("button", name="Маршруты и остановки", exact=True).click()
        self.expect(self.page.get_by_role("heading", name="Маршруты и остановки", level=1)).to_be_visible()
        self.expect(self.page.get_by_label("Маршрут", exact=True)).to_be_enabled()
        self.expect(self.page.get_by_role("button", name="Новый маршрут", exact=True)).to_be_enabled()

    def route(self):
        return expect_status(api_request(self.args.api_url, "/admin/routes/" + self.route_id, token=self.token), 200, "Read durable route")["route"]

    def assert_layout(self, route):
        require([stop["code"] for stop in route["stops"]] == ["A", "C", "B"], "Saved stop order must be A/C/B")
        require([stop["sequence"] for stop in route["stops"]] == [1, 2, 3], "Server sequences must be canonical")
        require([stop["position"] for stop in route["stops"]] == [1, 2, 3], "Server positions must be canonical")
        require(route.get("pitaks") == {"aStopCode": "A", "bStopCode": "B", "radiusMeters": 175}, "A/B selection and radius must persist")
        for stop in route["stops"]:
            lat, lng = self.expected_coordinates[stop["code"]]
            require(stop.get("location", {}).get("lat") == lat and stop.get("location", {}).get("lng") == lng, "Real stop coordinates must persist")
            require(bool(re.fullmatch(r"[0-9a-f-]{36}", stop["id"])), "New stop IDs must be assigned by the server")

    def choose_on_map(self, index, screenshot_name=None, apply=True):
        latitude = self.page.get_by_label(f"Широта остановки {index}", exact=True)
        longitude = self.page.get_by_label(f"Долгота остановки {index}", exact=True)
        before = (latitude.input_value(), longitude.input_value())
        writes_before = len(self.layout_requests)
        server_before = self.route() if not apply else None
        opener = self.page.get_by_role("button", name=f"Выбрать на карте: остановка {index}", exact=True)
        opener.click()
        region = self.page.get_by_role("region", name=f"Карта остановки {index}", exact=True)
        self.expect(region).to_be_visible()
        canvas = region.get_by_label("Карта выбора координат", exact=True)
        self.expect(canvas).to_be_visible()
        canvas.scroll_into_view_if_needed()
        # Require decoded, visible, actual OSM imagery. A map container or an
        # img tag alone cannot prove that the external basemap loaded.
        self.page.wait_for_function(
            """canvas => {
                const map = canvas.getBoundingClientRect();
                return [...canvas.querySelectorAll('img.leaflet-tile')].some(image => {
                    const tile = image.getBoundingClientRect();
                    return image.complete && image.naturalWidth > 0 &&
                        new URL(image.src).hostname === 'tile.openstreetmap.org' &&
                        image.classList.contains('leaflet-tile-loaded') &&
                        tile.right > map.left && tile.left < map.right &&
                        tile.bottom > map.top && tile.top < map.bottom;
                });
            }""",
            arg=canvas.element_handle(), timeout=30_000,
        )
        tiles = canvas.locator("img.leaflet-tile-loaded").evaluate_all(
            """images => images.filter(image => {
                const map = image.closest('.stop-map-canvas').getBoundingClientRect();
                const tile = image.getBoundingClientRect();
                return image.complete && image.naturalWidth > 0 &&
                    tile.right > map.left && tile.left < map.right &&
                    tile.bottom > map.top && tile.top < map.bottom;
            }).map(image => image.src)"""
        )
        require(tiles and all(self.is_map_tile(url) for url in tiles), "Map must load real OpenStreetMap tile images")
        require(any(tile.get("status") == 200 and tile["url"] in tiles for tile in self.map_tiles), "At least one visible map tile must have a real successful HTTP response")
        self.expect(region.get_by_role("link", name="OpenStreetMap", exact=False)).to_be_visible()
        bounds = canvas.bounding_box()
        require(bounds and bounds["width"] > 120 and bounds["height"] > 120, "Coordinate map must have a usable rendered area")
        preview = region.get_by_text(re.compile(r"^Выбрано:"))
        initial_preview = preview.inner_text() if preview.count() else None
        if not before[0].strip() and not before[1].strip():
            self.expect(region.get_by_text("Точка пока не выбрана.", exact=True)).to_be_visible()
            self.expect(region.get_by_role("button", name="Использовать эту точку", exact=True)).to_be_disabled()
        # Click away from the existing center marker and Leaflet controls.
        canvas.click(position={"x": bounds["width"] * 0.66, "y": bounds["height"] * 0.60})
        self.expect(preview).to_be_visible()
        if initial_preview is not None:
            self.expect(preview).not_to_have_text(initial_preview)
        self.expect(region.locator(".stop-map-marker")).to_be_visible()
        self.page.wait_for_function(
            """canvas => {
                const marker = canvas.querySelector('.stop-map-marker');
                if (!marker) return false;
                const map = canvas.getBoundingClientRect();
                const point = marker.getBoundingClientRect();
                return Math.abs(point.x + point.width / 2 - (map.x + map.width * 0.66)) <= 3 &&
                    Math.abs(point.y + point.height / 2 - (map.y + map.height * 0.60)) <= 3;
            }""",
            arg=canvas.element_handle(), timeout=5_000,
        )
        match = re.fullmatch(r"Выбрано:\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)", preview.inner_text().strip())
        require(match is not None, "Map click must display the selected latitude and longitude")
        selected = (float(match[1]), float(match[2]))
        require(all(math.isfinite(number) for number in selected) and -90 <= selected[0] <= 90 and -180 <= selected[1] <= 180, "Clicked map point must have finite geographic coordinates")
        if before[0].strip() and before[1].strip():
            require(selected != tuple(float(number) for number in before), "The actual map click must select a different point")
        self.expect(latitude).to_have_value(before[0])
        self.expect(longitude).to_have_value(before[1])
        if self.page.viewport_size["width"] == 390:
            require(self.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "390px open map picker must not overflow horizontally")
        if screenshot_name:
            self.screenshot(screenshot_name)
        if apply:
            region.get_by_role("button", name="Использовать эту точку", exact=True).click()
            self.expect(region).to_have_count(0)
            coordinates = (float(latitude.input_value()), float(longitude.input_value()))
            require(coordinates == selected, "Applying the map point must copy the selected coordinates into the stop fields")
            code = self.page.get_by_label(f"Код остановки {index}", exact=True).input_value().strip().upper()
            self.expected_coordinates[code] = coordinates
        else:
            region.get_by_role("button", name="Закрыть карту", exact=True).click()
            self.expect(region).to_have_count(0)
            self.expect(latitude).to_have_value(before[0])
            self.expect(longitude).to_have_value(before[1])
            require(self.route() == server_before, "Closing a candidate map point must leave the real server route unchanged")
        self.expect(opener).to_be_focused()
        require(len(self.layout_requests) == writes_before, "Choosing or cancelling a map point must not save a route automatically")
        self.map_selections.append({"stop_index": index, "coordinates": selected, "applied": apply, "viewport": self.page.viewport_size, "loaded_tiles": tiles})

    def assert_form(self, route):
        self.expect(self.page.get_by_role("heading", name=route["name"], level=2, exact=True)).to_be_visible()
        for index, stop in enumerate(route["stops"], 1):
            self.expect(self.page.get_by_label(f"Код остановки {index}", exact=True)).to_have_value(stop["code"])
            self.expect(self.page.get_by_label(f"Название остановки {index}", exact=True)).to_have_value(stop["name"])
            self.expect(self.page.get_by_label(f"Широта остановки {index}", exact=True)).to_have_value(str(stop["location"]["lat"]))
            self.expect(self.page.get_by_label(f"Долгота остановки {index}", exact=True)).to_have_value(str(stop["location"]["lng"]))
        self.expect(self.page.get_by_role("checkbox", name="Настроить питаки A/B", exact=True)).to_be_checked()
        self.expect(self.page.get_by_label("Питак A", exact=True)).to_have_value(route["stops"][0]["id"])
        self.expect(self.page.get_by_label("Питак B", exact=True)).to_have_value(route["stops"][-1]["id"])
        self.expect(self.page.get_by_label("Радиус питака, м", exact=True)).to_have_value("175")

    def currency_tariffs(self, passenger_token):
        legacy = self.route()
        require(legacy["currency"] == "KZT", "The original route must remain the legacy KZT fixture")
        name = "CI UZS tariff " + uuid.uuid4().hex[:10]
        self.page.set_viewport_size({"width": 1440, "height": 1000})
        self.page.get_by_role("button", name="Новый маршрут", exact=True).click()
        self.expect(self.page.get_by_label("Валюта нового маршрута", exact=True)).to_have_value("UZS")
        self.page.get_by_label("Название нового маршрута", exact=True).fill(name)
        self.page.get_by_label("Тариф нового маршрута", exact=True).fill("2500")
        with self.response_for("/admin/routes", "POST") as pending:
            self.page.get_by_role("button", name="Создать маршрут", exact=True).click()
        response = pending.value
        require(response.status == 201, "Actual browser must create the UZS route")
        require(response.request.post_data_json["currency"] == "UZS" and response.request.post_data_json["price_per_stop"] == 2500, "Browser must submit an explicit UZS amount without conversion")
        created = response.json()["route"]
        uzs_id = created["id"]
        self.uzs_route_id = uzs_id
        require(created["currency"] == "UZS" and created["pricePerStop"] == 2500 and "pricePerStopKzt" not in created, "New UZS route must not masquerade as a KZT tariff")
        self.expect(self.page.get_by_role("heading", name=name, level=2, exact=True)).to_be_visible()
        self.expect(self.page.get_by_label("Тариф за остановку", exact=True)).to_have_value("2500")
        self.expect(self.page.get_by_test_id("saved-route-tariff")).to_contain_text("сум")
        path = "/admin/routes/" + uzs_id
        self.page.get_by_label("Тариф за остановку", exact=True).fill("3500")
        self.page.get_by_label("Маршрут", exact=True).select_option(self.route_id)
        self.expect(self.page.get_by_role("button", name="Остаться", exact=True)).to_be_visible()
        self.page.get_by_role("button", name="Остаться", exact=True).click()
        self.expect(self.page.get_by_label("Тариф за остановку", exact=True)).to_have_value("3500")
        self.page.get_by_role("button", name="Загрузить текущую версию", exact=True).click()
        self.expect(self.page.get_by_role("button", name="Оставить черновик", exact=True)).to_be_visible()
        self.page.get_by_role("button", name="Оставить черновик", exact=True).click()
        self.expect(self.page.get_by_label("Тариф за остановку", exact=True)).to_have_value("3500")
        with self.response_for(path, "PATCH") as pending:
            self.page.get_by_role("button", name="Сохранить тариф", exact=True).click()
        require(pending.value.status == 200, "Tariff editing must call the real administrator API")
        require(pending.value.request.post_data_json == {"price_per_stop": 3500}, "Editing a tariff must retain the route currency")
        updated = pending.value.json()["route"]
        require(updated["currency"] == "UZS" and updated["pricePerStop"] == 3500 and "pricePerStopKzt" not in updated, "Saved UZS tariff must remain neutral and explicit")
        self.expect(self.page.get_by_label("Тариф за остановку", exact=True)).to_have_value("3500")
        # Use the real editor to choose the same three stops in this new route;
        # no response interception or synthetic price is substituted.
        for index, stop in enumerate(legacy["stops"], 1):
            self.page.get_by_role("button", name="Добавить остановку", exact=True).click()
            self.page.get_by_label(f"Код остановки {index}", exact=True).fill(stop["code"])
            self.page.get_by_label(f"Название остановки {index}", exact=True).fill(stop["name"])
            if stop.get("location"):
                self.page.get_by_label(f"Широта остановки {index}", exact=True).fill(str(stop["location"]["lat"]))
                self.page.get_by_label(f"Долгота остановки {index}", exact=True).fill(str(stop["location"]["lng"]))
        self.page.get_by_label("Тариф за остановку", exact=True).fill("3600")
        self.expect(self.page.get_by_role("button", name="Сохранить тариф", exact=True)).to_be_disabled()
        with self.response_for(path + "/layout", "PUT") as pending:
            self.page.get_by_role("button", name="Сохранить остановки и питаки", exact=True).click()
        require(pending.value.status == 200, "Actual admin editor must save the selected UZS stops")
        updated = pending.value.json()["route"]
        require(updated["currency"] == "UZS" and updated["pricePerStop"] == 3500, "Saving stop geometry must retain the edited UZS tariff")
        self.expect(self.page.get_by_label("Тариф за остановку", exact=True)).to_have_value("3600")
        self.page.get_by_label("Тариф за остановку", exact=True).fill("3500")  # Explicitly discard only the unsaved tariff draft.
        fare = expect_status(api_request(self.args.api_url, "/fares/estimate", "POST", {"route_id": uzs_id, "pickup_stop": updated["stops"][0]["id"], "destination_stop": updated["stops"][-1]["id"]}, passenger_token), 200, "Actual passenger quote from admin-selected UZS stops")["fare"]
        require(fare["currency"] == "UZS" and fare["pricePerStop"] == 3500 and fare["distanceStops"] == 2 and fare["total"] == 7000, "Server quote must use the selected two-stop distance and edited UZS unit tariff")
        require("totalKzt" not in fare and "pricePerStopKzt" not in fare, "Actual UZS quote must not expose KZT amount aliases")
        self.passed("Actual admin UI creates and edits UZS tariff; selected stops produce the correct real passenger quote")

        self.page.reload(wait_until="domcontentloaded")
        self.expect(self.page.get_by_role("heading", name="Вход в панель", exact=True)).to_be_visible()
        self.login()
        self.open_routes()
        self.page.get_by_label("Маршрут", exact=True).select_option(uzs_id)
        self.expect(self.page.get_by_role("heading", name=name, level=2, exact=True)).to_be_visible()
        self.expect(self.page.get_by_label("Тариф за остановку", exact=True)).to_have_value("3500")
        self.expect(self.page.get_by_test_id("saved-route-tariff")).to_contain_text("сум")
        require(expect_status(api_request(self.args.api_url, path, token=self.token), 200, "Durable UZS route")["route"] == updated, "Reload must restore the actual persisted UZS tariff")
        require(self.route() == legacy, "Creating and editing UZS must not relabel or mutate the old KZT route")
        self.page.get_by_label("Маршрут", exact=True).select_option(self.route_id)
        self.expect(self.page.get_by_label("Тариф за остановку", exact=True)).to_have_value(str(legacy["pricePerStopKzt"]))
        self.expect(self.page.get_by_test_id("saved-route-tariff")).to_contain_text("₸")
        self.page.get_by_label("Маршрут", exact=True).select_option(uzs_id)
        self.expect(self.page.get_by_label("Тариф за остановку", exact=True)).to_have_value("3500")
        self.page.set_viewport_size({"width": 390, "height": 844})
        require(self.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "UZS tariff form must fit the 390px viewport")
        self.screenshot("mobile-390-uzs-tariff")
        self.passed("Browser reload retains UZS while the original KZT tariff and mobile layout stay intact")

        rejected = expect_status(api_request(self.args.api_url, path, "PATCH", {"currency": "KZT", "price_per_stop": 999}, self.token), 409, "Administrator currency relabelling denied")
        require(rejected.get("error", {}).get("code") == "ROUTE_CURRENCY_IMMUTABLE", "Currency mutation must fail with its explicit server conflict")
        expect_status(api_request(self.args.api_url, path, "PATCH", {"currency": "KZT", "price_per_stop": 999}, passenger_token), 403, "Passenger tariff/currency write denied")
        require(expect_status(api_request(self.args.api_url, path, token=self.token), 200, "UZS after rejected writes")["route"] == updated, "Rejected currency/authority writes must not change the tariff")
        self.passed("Server refuses currency relabelling and passenger tariff writes without changing UZS data")

    def vehicle_review(self):
        phone = "+77775" + str(uuid.uuid4().int % 1_000_000).zfill(6)
        challenge = expect_status(api_request(self.args.api_url, "/auth/request-otp", "POST", {"phone_number": phone, "full_name": "CI vehicle review driver", "role": "driver", "locale": "ru"}), 202, "Driver fixture OTP")
        session = expect_status(api_request(self.args.api_url, "/auth/verify-otp", "POST", {"phone_number": phone, "code": challenge["demo_code"]}), 200, "Real driver fixture authentication")
        driver, driver_token = session["user"], session["access_token"]
        self.reviewed_driver_id = driver["id"]
        self.reviewed_driver_token = driver_token
        body = {"make": "Chevrolet", "model": "QA Cobalt", "plate_number": "01 T123 QA", "seat_capacity": 4, "expected_revision": None}
        first = expect_status(api_request(self.args.api_url, "/driver/vehicle", "PUT", body, driver_token), 200, "Driver submits a real vehicle")["driver_vehicle"]
        self.page.set_viewport_size({"width": 1440, "height": 1000})
        self.page.get_by_role("button", name="Пользователи", exact=True).click()
        self.page.get_by_role("tab", name="Водители", exact=True).click()
        with self.response_for("/admin/drivers", "GET"):
            self.page.get_by_role("button", name="Обновить", exact=True).click()
        card = self.page.get_by_test_id("driver-vehicle-review-" + driver["id"])
        self.expect(card).to_contain_text("QA Cobalt")
        self.expect(card).to_contain_text("01 T123 QA")
        approval_path = "/admin/drivers/" + driver["id"] + "/approval"
        approve = self.page.get_by_test_id("driver-vehicle-approve-" + driver["id"])
        with self.response_for(approval_path, "PATCH") as pending:
            approve.click()
        require(pending.value.status == 200 and pending.value.request.post_data_json["expected_vehicle_revision"] == first["revision"], "Actual administrator must approve the displayed vehicle revision")
        self.expect(self.page.locator("tr").filter(has=card)).to_contain_text("Одобрен")
        changed = expect_status(api_request(self.args.api_url, "/driver/vehicle", "PUT", {**body, "model": "QA Nexia", "expected_revision": first["revision"]}, driver_token), 200, "Driver changes vehicle before old review")
        require(changed["approval_status"] == "pending", "Edited vehicle must lose prior approval")
        with self.response_for(approval_path, "PATCH") as pending:
            approve.click()
        require(pending.value.status == 409 and pending.value.json().get("error", {}).get("code") == "VEHICLE_REVIEW_CHANGED", "Stale actual review must fail with the exact conflict code")
        self.vehicle_conflict_path, self.vehicle_conflict_observed = "/api" + approval_path, True
        self.expect(card.get_by_role("alert")).to_contain_text("Автомобиль изменился")
        with self.response_for("/admin/drivers", "GET"):
            self.page.get_by_role("button", name="Обновить", exact=True).click()
        self.expect(card).to_contain_text("QA Nexia")
        self.expect(card.get_by_role("alert")).to_have_count(0)
        with self.response_for(approval_path, "PATCH") as pending:
            self.page.get_by_test_id("driver-vehicle-reject-" + driver["id"]).click()
        require(pending.value.status == 200 and pending.value.json()["driver"]["driver_approval_status"] == "rejected", "Actual administrator rejection must persist")
        self.expect(self.page.locator("tr").filter(has=card)).to_contain_text("Отклонён")
        with self.response_for(approval_path, "PATCH") as pending:
            approve.click()
        require(pending.value.status == 200 and pending.value.request.post_data_json["expected_vehicle_revision"] == changed["driver_vehicle"]["revision"], "Explicit fresh approval must bind the new vehicle")
        self.expect(self.page.locator("tr").filter(has=card)).to_contain_text("Одобрен")
        self.page.set_viewport_size({"width": 390, "height": 844})
        require(self.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "Driver review must not overflow the 390px admin page")
        self.screenshot("mobile-390-reviewed-vehicle")
        self.passed("Actual administrator reviews persisted car, rejects stale vehicle revision, and explicitly approves updated data")

    def audit_journal(self, passenger_token):
        path = "/admin/audit-events"
        self.page.set_viewport_size({"width": 1440, "height": 1000})
        with self.response_for(path, "GET") as pending:
            self.page.get_by_role("button", name="Журнал действий", exact=True).click()
        panel = self.page.get_by_test_id("admin-audit-journal")
        response = pending.value
        require(response.status == 200 and response.headers.get("cache-control") == "no-store", "Journal must read the real protected uncached API")
        events = response.json()["events"]
        require(len(events) > 0, "Existing route and approval writes must create actual journal entries")
        self.expect(panel.get_by_test_id("audit-event-" + events[0]["id"])).to_contain_text(events[0]["actorId"])
        self.expect(panel.locator("ol > li")).to_have_count(len(events))
        require([card.get_attribute("data-testid") for card in panel.locator("ol > li").all()] == ["audit-event-" + event["id"] for event in events], "Rendered audit order must exactly match the server window")
        self.expect(panel).to_contain_text("Последние не более 50")
        self.screenshot("desktop-audit-journal")
        self.passed("Actual admin journal displays durable audit events in server order without fabricating actor identities or totals")

        def apply():
            with self.response_for(path, "GET") as pending:
                panel.get_by_role("button", name="Применить фильтры", exact=True).click()
            require(pending.value.status == 200, "Actual journal filter must be accepted")
            records = pending.value.json()["events"]
            self.expect(panel.locator("ol > li")).to_have_count(len(records))
            self.expect(panel.get_by_role("button", name="Применить фильтры", exact=True)).to_be_enabled()
            return records, pending.value

        panel.get_by_label("ID маршрута", exact=True).fill(self.uzs_route_id)
        records, response = apply()
        require(records and all(event.get("routeId") == self.uzs_route_id for event in records), "Route filter must bind actual UZS metadata events")
        require(any(event.get("changedFields") == ["pricePerStop"] for event in records), "Tariff update must appear as actual generic price field")
        for event in records:
            card = panel.get_by_test_id("audit-event-" + event["id"])
            self.expect(card).to_contain_text("Маршрут изменён")
            self.expect(card).to_contain_text(event["previousVersion"])
            self.expect(card).to_contain_text(event["nextVersion"])
        panel.get_by_label("ID маршрута", exact=True).fill("")
        panel.get_by_label("ID водителя", exact=True).fill(self.reviewed_driver_id)
        records, response = apply()
        require(len(records) == 3 and all(event.get("driverId") == self.reviewed_driver_id for event in records), "Exactly three real approval changes must appear; rejected stale write must add no event")
        self.expect(panel).to_contain_text("Одобрен")
        self.expect(panel).to_contain_text("Отклонён")
        self.passed("Route and driver filters expose real tariff revisions and exactly three approval changes while preserving the rejected stale-write boundary")

        panel.get_by_label("ID маршрута", exact=True).fill(self.uzs_route_id)
        records, response = apply()
        require(records == [], "Combined unrelated driver and route filters must use real server AND semantics")
        self.expect(panel.get_by_text("По заданным фильтрам событий нет.", exact=True)).to_be_visible()
        with self.response_for(path, "GET") as pending:
            panel.get_by_role("button", name="Сбросить фильтры", exact=True).click()
        require(pending.value.status == 200 and pending.value.json()["events"], "Reset must reload the genuine latest event window")
        self.expect(panel.get_by_role("button", name="Применить фильтры", exact=True)).to_be_enabled()
        panel.get_by_label("Показывать не более", exact=True).select_option("25")
        records, response = apply()
        require("limit=25" in response.url and len(records) <= 25, "Selected limit must be sent to the actual server")
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.expect(panel).to_contain_text("Последние не более 25")
        require(self.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "390px journal must wrap IDs and filters without page overflow")
        self.screenshot("mobile-390-audit-journal")
        self.passed("Journal AND filters show a genuine empty state, reset reloads real events and the bounded list fits390px")

        pattern = "**/api/admin/audit-events?*"
        def disconnect(route):
            self.audit_network_failure = True
            route.abort("connectionfailed")
        self.page.route(pattern, disconnect)
        try:
            panel.get_by_role("button", name="Обновить журнал", exact=True).click()
            self.expect(panel.get_by_role("alert")).to_be_visible()
            self.expect(panel.locator("ol > li")).to_have_count(0)
            self.expect(panel.get_by_text("По заданным фильтрам событий нет.", exact=True)).to_have_count(0)
        finally:
            self.page.unroute(pattern, disconnect)
        with self.response_for(path, "GET") as pending:
            panel.get_by_role("button", name="Обновить журнал", exact=True).click()
        require(pending.value.status == 200, "Retry after real transport failure must reload the actual API")
        self.expect(panel.get_by_role("alert")).to_have_count(0)
        self.expect(panel.locator("ol > li")).to_have_count(len(pending.value.json()["events"]))
        expect_status(api_request(self.args.api_url, path, token=passenger_token), 403, "Passenger audit read denied")
        expect_status(api_request(self.args.api_url, path, token=self.reviewed_driver_token), 403, "Driver audit read denied")
        expect_status(api_request(self.args.api_url, path), 401, "Unauthenticated audit read denied")
        self.passed("Journal transport failure is distinct from empty history, explicit retry recovers real data and non-admin reads remain forbidden")

    def admin_orders(self, passenger_token):
        route = expect_status(api_request(self.args.api_url, "/admin/routes/" + self.uzs_route_id, token=self.token), 200, "Current real UZS route for admin order QA")["route"]
        # The tariff-only scenario saves stops without assigning origin pitaks.
        # Enroll through a genuinely configured route; do not bypass that guard.
        route = expect_status(api_request(self.args.api_url, "/admin/routes/" + route["id"] + "/layout", "PUT", {
            "expected_updated_at": route["updatedAt"],
            "stops": [{"id": stop["id"], "code": stop["code"], "name": stop["name"],
                "location": {"lat": stop["location"]["lat"], "lng": stop["location"]["lng"]}} for stop in route["stops"]],
            "pitaks": {"a_stop_code": route["stops"][0]["code"], "b_stop_code": route["stops"][-1]["code"], "radius_meters": 175},
        }, self.token), 200, "Configure actual pitaks before enrolling the admin cancellation fixture")["route"]
        choice = {"route_id": route["id"], "direction": "a_to_b", "expected_updated_at": route["updatedAt"]}
        start, destination = route["stops"][0], route["stops"][-1]
        location = {**start["location"], "timestamp": int(time.time() * 1000)}
        driver_token = self.reviewed_driver_token
        expect_status(api_request(self.args.api_url, "/driver/route", "PUT", choice, driver_token), 200, "Persist actual driver choice for admin cancellation")
        expect_status(api_request(self.args.api_url, "/queue/join", "POST", {"route_choice": choice, "available_seats": 4, "location": location}, driver_token), 201, "Join actual four-seat FIFO")
        def capacity(expected):
            queue = expect_status(api_request(self.args.api_url, "/admin/queue", token=self.token), 200, "Read actual queue after admin cancellation")["queue"]
            entry = next(item for item in queue if item["driver_id"] == self.reviewed_driver_id)
            require(entry["available_seats"] == expected, "Actual queue capacity must equal " + str(expected))
        def create():
            body = {**choice, "pickup_stop_id": start["id"], "destination_stop_id": destination["id"], "pickup_location": {**location, "timestamp": int(time.time() * 1000)}, "seats": 2}
            order = expect_status(api_request(self.args.api_url, "/orders/route", "POST", body, passenger_token), 201, "Create actual two-seat UZS order")["order"]
            require(order["offered_driver_id"] == self.reviewed_driver_id and order["status"] == "searching", "Real FIFO must offer the order to the approved fixture driver")
            capacity(2)
            return order
        def audit(order_id, previous_status):
            events = expect_status(api_request(self.args.api_url, "/admin/audit-events?order_id=" + order_id, token=self.token), 200, "Read actual cancellation audit")["events"]
            require(len(events) == 1 and events[0]["action"] == "order.cancelled" and events[0]["fromStatus"] == previous_status and events[0]["toStatus"] == "cancelled", "Exactly one actual cancellation event must describe the true transition")
            actor = expect_status(api_request(self.args.api_url, "/auth/me", token=self.token), 200, "Read current administrator actor")["user"]
            require(events[0]["actorId"] == actor["id"], "Cancellation audit must identify the actual current administrator")
            return events[0]
        def refresh():
            with self.response_for("/admin/orders", "GET") as pending:
                panel.get_by_role("button", name="Обновить заказы", exact=True).click()
            require(pending.value.status == 200, "Actual orders refresh must succeed")
            self.expect(panel.get_by_role("button", name="Обновить заказы", exact=True)).to_be_enabled()
        def status_filter(value):
            with self.response_for("/admin/orders", "GET") as pending:
                panel.get_by_label("Статус заказов", exact=True).select_option(value)
            require(pending.value.status == 200 and "status=" + value in pending.value.url, "Actual order status filter must reach the server")
            self.expect(panel.get_by_role("button", name="Обновить заказы", exact=True)).to_be_enabled()
        def open_confirm(order):
            panel.get_by_test_id("admin-cancel-open-" + order["id"]).click()
            dialog = panel.get_by_role("alertdialog")
            self.expect(dialog).to_contain_text(order["id"])
            self.expect(dialog).to_contain_text("Мест: 2")
            return dialog

        first = create()
        self.page.set_viewport_size({"width": 1440, "height": 1000})
        with self.response_for("/admin/orders", "GET") as pending:
            self.page.get_by_role("button", name="Заказы", exact=True).click()
        require(pending.value.status == 200, "Actual admin orders section must load protected data")
        panel = self.page.get_by_test_id("admin-orders")
        card = panel.get_by_test_id("admin-order-" + first["id"])
        self.expect(card).to_contain_text("Мест: 2")
        self.expect(card).to_contain_text("сум")
        expected_amount = str(first["fare"]["total"])
        require(expected_amount in re.sub(r"\s", "", card.inner_text()), "Admin must render the frozen actual UZS fare without conversion")
        before = len(self.order_cancel_requests)
        dialog = open_confirm(first)
        dialog.get_by_role("button", name="Сохранить заказ", exact=True).click()
        self.expect(panel.get_by_role("alertdialog")).to_have_count(0)
        require(len(self.order_cancel_requests) == before, "Dismissing confirmation must send zero cancellation POSTs")
        capacity(2)
        self.screenshot("desktop-admin-orders")
        self.passed("Actual order list displays frozen UZS fare and dismissing explicit confirmation preserves both the order and reserved seats")

        dialog = open_confirm(first)
        path = "/admin/orders/" + first["id"] + "/cancel"
        with self.response_for(path, "POST") as pending:
            dialog.get_by_role("button", name="Подтвердить отмену", exact=True).click()
        require(pending.value.status == 200 and pending.value.request.post_data_json == {"expected_status": "searching"}, "Confirmed cancellation must submit only the exact observed status")
        require(pending.value.json()["order"]["id"] == first["id"] and pending.value.json()["order"]["status"] == "cancelled", "Actual server must confirm cancellation of that exact order")
        self.expect(card).to_have_count(0)
        self.expect(panel.get_by_role("button", name="Обновить заказы", exact=True)).to_be_enabled()
        capacity(4)
        audit(first["id"], "searching")
        expect_status(api_request(self.args.api_url, path, "POST", {"expected_status": "searching"}, self.token), 409, "Repeated cancellation must not succeed twice")
        capacity(4)
        audit(first["id"], "searching")
        self.passed("Confirmed admin cancellation releases exactly two seats once and creates one authentic audit event; duplicate cancellation changes neither")

        second = create()
        refresh()
        dialog = open_confirm(second)
        accepted = expect_status(api_request(self.args.api_url, "/orders/" + second["id"] + "/accept", "POST", {}, driver_token), 200, "Real driver accepts while administrator sees old searching status")["order"]
        require(accepted["status"] == "en_route_to_c", "Concurrent actual driver acceptance must change status")
        second_path = "/admin/orders/" + second["id"] + "/cancel"
        before = len(self.order_cancel_requests)
        with self.response_for(second_path, "POST") as pending:
            dialog.get_by_role("button", name="Подтвердить отмену", exact=True).click()
        require(pending.value.status == 409 and pending.value.json().get("error", {}).get("code") == "ORDER_UNAVAILABLE", "Stale confirmation must be rejected by actual status compare")
        self.order_conflict_paths.add("/api" + second_path)
        self.expect(panel.get_by_role("alertdialog")).to_have_count(0)
        self.expect(panel.get_by_role("alert")).to_contain_text("Обновите список")
        self.expect(panel.get_by_test_id("admin-cancel-open-" + second["id"])).to_be_disabled()
        capacity(2)
        require(len(self.order_cancel_requests) == before + 1, "A conflict must not automatically retry cancellation")
        refresh()
        dialog = open_confirm(second)
        self.expect(dialog).to_contain_text("Едет к точке посадки")
        with self.response_for(second_path, "POST") as pending:
            dialog.get_by_role("button", name="Подтвердить отмену", exact=True).click()
        require(pending.value.status == 200 and pending.value.request.post_data_json == {"expected_status": "en_route_to_c"}, "Only fresh explicit confirmation may cancel the changed order")
        self.expect(panel.get_by_test_id("admin-order-" + second["id"])).to_have_count(0)
        self.expect(panel.get_by_role("button", name="Обновить заказы", exact=True)).to_be_enabled()
        capacity(4)
        audit(second["id"], "en_route_to_c")
        self.passed("Concurrent real acceptance rejects stale admin confirmation, blocks further mutations until refresh and requires a new explicit decision")

        third = create()
        refresh()
        dialog = open_confirm(third)
        third_path = "/admin/orders/" + third["id"] + "/cancel"
        forwarded = {}
        pattern = "**/api" + third_path
        def lose_response(route_request):
            result = route_request.fetch()
            try:
                forwarded["status"] = result.status
                forwarded["body"] = result.json()
            finally:
                result.dispose()
            self.order_network_failure_path = "/api" + third_path
            route_request.abort("connectionfailed")
        before = len(self.order_cancel_requests)
        self.page.route(pattern, lose_response)
        try:
            dialog.get_by_role("button", name="Подтвердить отмену", exact=True).click()
            self.expect(panel.get_by_role("alert")).to_contain_text("Результат отмены не подтверждён")
        finally:
            self.page.unroute(pattern, lose_response)
        require(forwarded.get("status") == 200 and forwarded.get("body", {}).get("order", {}).get("status") == "cancelled", "The real cancellation must commit before its response is deliberately lost")
        self.expect(panel.get_by_test_id("admin-cancel-open-" + third["id"])).to_be_disabled()
        require(len(self.order_cancel_requests) == before + 1, "Lost successful response must not trigger another POST")
        capacity(4)
        audit(third["id"], "searching")
        refresh()
        self.expect(panel.get_by_test_id("admin-order-" + third["id"])).to_have_count(0)
        self.passed("A genuinely committed cancellation with lost response remains blocked until explicit authoritative refresh without automatic retry or double release")

        fourth = create()
        expect_status(api_request(self.args.api_url, "/orders/" + fourth["id"] + "/accept", "POST", {}, driver_token), 200, "Accept actual completed-order fixture")
        for status in ("arrived_at_c", "in_transit", "completed"):
            finished = expect_status(api_request(self.args.api_url, "/orders/" + fourth["id"] + "/status", "PATCH", {"status": status}, driver_token), 200, "Progress actual order to " + status)["order"]
            require(finished["status"] == status, "Real trip status must be persisted")
        finished_entry = expect_status(api_request(self.args.api_url, "/queue", token=driver_token), 200, "Read completed driver's own durable enrollment")["your_entry"]
        require(finished_entry["availableSeats"] == 4 and finished_entry["inFifo"] is False,
            "Completion must restore capacity while leaving the completed origin enrollment outside FIFO")
        status_filter("completed")
        completed_card = panel.get_by_test_id("admin-order-" + fourth["id"])
        self.expect(completed_card).to_contain_text("Завершён")
        self.expect(completed_card.get_by_role("button", name="Отменить заказ", exact=True)).to_have_count(0)
        status_filter("cancelled")
        closed = panel.get_by_test_id("admin-order-" + first["id"])
        self.expect(closed).to_contain_text("Отменён")
        self.expect(closed.get_by_role("button", name="Отменить заказ", exact=True)).to_have_count(0)
        panel.get_by_label("Поиск по ID заказа", exact=True).fill(first["id"])
        self.expect(panel.locator("ol > li")).to_have_count(1)
        panel.get_by_label("Поиск по ID заказа", exact=True).fill("not-an-existing-order")
        self.expect(panel.get_by_text("Заказы по заданным фильтрам не найдены.", exact=True)).to_be_visible()
        panel.get_by_label("Поиск по ID заказа", exact=True).fill("")
        self.page.set_viewport_size({"width": 390, "height": 844})
        require(self.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "390px admin orders must wrap IDs and controls without overflow")
        self.screenshot("mobile-390-admin-orders")
        expect_status(api_request(self.args.api_url, "/admin/orders", token=passenger_token), 403, "Passenger cannot list admin orders")
        expect_status(api_request(self.args.api_url, "/admin/orders", token=driver_token), 403, "Driver cannot list admin orders")
        expect_status(api_request(self.args.api_url, path, "POST", {"expected_status": "searching"}, passenger_token), 403, "Passenger cannot use admin cancellation")
        expect_status(api_request(self.args.api_url, path, "POST", {"expected_status": "searching"}, driver_token), 403, "Driver cannot use admin cancellation")
        self.passed("Actual completed/cancelled orders are read-only, ID search and mobile390px work, and passenger/driver administrative access stays forbidden")

        with self.response_for("/admin/audit-events", "GET"):
            self.page.get_by_role("button", name="Журнал действий", exact=True).click()
        journal = self.page.get_by_test_id("admin-audit-journal")
        self.expect(journal.get_by_role("button", name="Применить фильтры", exact=True)).to_be_enabled()
        journal.get_by_label("ID заказа", exact=True).fill(first["id"])
        with self.response_for("/admin/audit-events", "GET") as pending:
            journal.get_by_role("button", name="Применить фильтры", exact=True).click()
        events = pending.value.json()["events"]
        require(len(events) == 1 and events[0]["action"] == "order.cancelled", "UI order journal filter must return exactly the actual admin cancellation")
        event_card = journal.get_by_test_id("audit-event-" + events[0]["id"])
        self.expect(event_card).to_contain_text("Заказ отменён администратором")
        self.expect(event_card).to_contain_text(first["id"])
        self.screenshot("mobile-390-order-cancellation-audit")
        self.passed("Actual administrative cancellation appears in the real journal UI with the correct order and exactly one event")
        self.admin_monitoring(passenger_token, route, choice, start, destination)

    def admin_monitoring(self, passenger_token, route, choice, start, destination):
        # All data below is persisted by the actual API. No monitoring response
        # is fabricated; one genuine transport failure and one delayed real
        # response exercise recovery and unmount fencing.
        driver_token = self.reviewed_driver_token
        expect_status(api_request(self.args.api_url, "/queue/leave", "DELETE", token=driver_token), 204, "Leave completed origin enrollment before monitoring fixture")
        expect_status(api_request(self.args.api_url, "/driver/route", "PUT", choice, driver_token), 200, "Retain real monitoring route choice")
        location = {**start["location"], "timestamp": int(time.time() * 1000)}
        expect_status(api_request(self.args.api_url, "/queue/join", "POST", {"route_choice": choice, "available_seats": 4, "location": location}, driver_token), 201, "Enroll actual monitoring FIFO driver")
        body = {**choice, "pickup_stop_id": start["id"], "destination_stop_id": destination["id"], "pickup_location": location, "seats": 2}
        order = expect_status(api_request(self.args.api_url, "/orders/route", "POST", body, passenger_token), 201, "Create real active monitoring order")["order"]
        require(order["offered_driver_id"] == self.reviewed_driver_id, "Monitoring fixture must be offered through actual FIFO")
        before = len(self.admin_requests)
        self.page.set_viewport_size({"width": 1440, "height": 1000})
        with self.response_for("/admin/queue", "GET") as pending:
            self.page.get_by_role("button", name="Мониторинг", exact=True).click()
        require(pending.value.status == 200 and "include_lanes=true" in pending.value.url, "Monitoring must explicitly request safe actual lane metadata")
        panel = self.page.get_by_test_id("admin-monitoring")
        snapshot = panel.get_by_test_id("monitor-snapshot")
        self.expect(snapshot).to_be_visible()
        card = panel.get_by_test_id("monitor-order-" + order["id"])
        driver = panel.get_by_test_id("monitor-driver-" + self.reviewed_driver_id)
        self.expect(card).to_contain_text("Поиск водителя")
        self.expect(card).to_contain_text("Мест: 2")
        self.expect(card).to_contain_text("сум")
        require(str(order["fare"]["total"]) in re.sub(r"\s", "", card.inner_text()), "Monitor must show frozen real server UZS fare")
        self.expect(driver).to_contain_text(route["name"])
        self.expect(driver).to_contain_text("A → B")
        self.expect(driver).to_contain_text("Питак A")
        self.expect(driver).to_contain_text("Место в очереди: 1")
        self.expect(driver).to_contain_text("Свободных мест: 2")
        self.expect(panel.get_by_role("checkbox", name="Автообновление каждые 10 секунд", exact=True)).to_be_checked()
        require(all(item["method"] == "GET" for item in self.admin_requests[before:]), "Opening monitoring may only issue reads")
        self.identity()
        self.screenshot("desktop-admin-monitoring")
        self.passed("Actual monitoring displays protected active orders, frozen UZS fare and the correct durable FIFO lane without writes")

        accepted = expect_status(api_request(self.args.api_url, "/orders/" + order["id"] + "/accept", "POST", {}, driver_token), 200, "Accept real monitored offer")["order"]
        require(accepted["status"] == "en_route_to_c", "Real acceptance must change the monitored order")
        self.expect(card).to_contain_text("Едет к точке посадки", timeout=25_000)
        cancelled = expect_status(api_request(self.args.api_url, "/admin/orders/" + order["id"] + "/cancel", "POST", {"expected_status": "en_route_to_c"}, self.token), 200, "Cancel real monitored assigned order")["order"]
        require(cancelled["status"] == "cancelled", "Actual monitored cancellation must commit")
        self.expect(card).to_have_count(0, timeout=25_000)
        self.expect(snapshot).to_be_visible()
        self.expect(card).to_have_count(0)
        active = expect_status(api_request(self.args.api_url, "/admin/orders?status=active", token=self.token), 200, "Authoritative active order comparison")["orders"]
        if not active:
            self.expect(panel.get_by_text("Активных заказов нет.", exact=True)).to_be_visible()
        self.expect(panel.get_by_test_id("monitor-driver-" + self.reviewed_driver_id)).to_contain_text("Свободных мест: 4")
        self.passed("Completion-based auto refresh observes real acceptance and committed cancellation, removes closed orders and restores actual seat counts")

        toggle = panel.get_by_role("checkbox", name="Автообновление каждые 10 секунд", exact=True)
        with self.response_for("/admin/queue", "GET"):
            toggle.uncheck()
        self.expect(snapshot).to_be_visible()
        self.expect(panel.get_by_role("button", name="Обновить мониторинг", exact=True)).to_be_enabled()
        reads_before_pause = len([item for item in self.admin_requests if item["path"] in {"/api/admin/queue", "/api/admin/orders"}])
        self.page.wait_for_timeout(11_000)
        reads_after_pause = len([item for item in self.admin_requests if item["path"] in {"/api/admin/queue", "/api/admin/orders"}])
        require(reads_before_pause == reads_after_pause, "Unchecked auto refresh must not keep polling")
        self.expect(snapshot).to_be_visible()
        self.passed("Administrator can pause monitoring updates without silently issuing overlapping or continuing polls")

        pattern = "**/api/admin/queue?include_lanes=true"
        def disconnect(request_route):
            self.monitor_network_failure = True
            request_route.abort("connectionfailed")
        self.page.route(pattern, disconnect)
        try:
            panel.get_by_role("button", name="Обновить мониторинг", exact=True).click()
            self.expect(panel.get_by_role("alert")).to_contain_text("Не удалось обновить мониторинг")
            self.expect(snapshot).to_have_count(0)
            self.expect(panel.get_by_text("Активных заказов нет.", exact=True)).to_have_count(0)
            self.expect(panel.get_by_text("В очереди нет водителей.", exact=True)).to_have_count(0)
        finally:
            self.page.unroute(pattern, disconnect)
        with self.response_for("/admin/queue", "GET") as pending:
            panel.get_by_role("button", name="Обновить мониторинг", exact=True).click()
        require(pending.value.status == 200, "Monitoring retry must use the actual recovered API")
        self.expect(snapshot).to_be_visible()
        self.expect(panel.get_by_role("alert")).to_have_count(0)
        self.expect(panel.get_by_test_id("monitor-driver-" + self.reviewed_driver_id)).to_contain_text("Свободных мест: 4")
        self.passed("Actual monitoring transport failure clears stale snapshots, stays distinct from empty data and recovers by explicit reload")

        # Hold only the promise for one already received genuine queue response.
        # No body/status is mocked, and the browser's original fetch is restored.
        self.page.evaluate("""() => {
          const original = window.fetch;
          window.__restoreMonitoringFetch = () => { window.fetch = original; delete window.__restoreMonitoringFetch; };
          let hold = true;
          window.fetch = async (...args) => {
            const response = await original(...args);
            const target = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
            if (hold && target.pathname === '/api/admin/queue' && target.searchParams.get('include_lanes') === 'true') {
              hold = false;
              return new Promise(resolve => { window.__releaseMonitoringResponse = () => { delete window.__releaseMonitoringResponse; resolve(response); }; });
            }
            return response;
          };
        }""")
        try:
            panel.get_by_role("button", name="Обновить мониторинг", exact=True).click()
            self.page.wait_for_function("typeof window.__releaseMonitoringResponse === 'function'")
            self.page.get_by_role("button", name="Пользователи", exact=True).click()
            self.expect(self.page.get_by_test_id("admin-monitoring")).to_have_count(0)
            self.page.evaluate("() => window.__releaseMonitoringResponse()")
            self.page.wait_for_timeout(100)
            self.expect(self.page.get_by_test_id("admin-monitoring")).to_have_count(0)
        finally:
            self.page.evaluate("() => { window.__releaseMonitoringResponse?.(); window.__restoreMonitoringFetch?.(); }")
        with self.response_for("/admin/queue", "GET"):
            self.page.get_by_role("button", name="Мониторинг", exact=True).click()
        self.expect(panel.get_by_test_id("monitor-snapshot")).to_be_visible()
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.identity()
        require(self.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "390px monitoring must wrap IDs, lane names and controls without horizontal overflow")
        self.screenshot("mobile-390-admin-monitoring")
        require(all(item["method"] == "GET" for item in self.admin_requests[before:]), "Every browser monitoring interaction must remain read-only")
        self.passed("Unmount discards a delayed genuine monitoring response and fresh mobile390px mounting renders safely without overflow")

    def run(self):
        expect_status(api_request(self.args.api_url, "/healthz"), 200, "Actual API health")
        expect_status(api_request(self.args.base_url, "/healthz"), 200, "Same-origin API health")
        self.page.goto(self.args.base_url.rstrip("/") + "/admin", wait_until="domcontentloaded")
        self.login()
        self.open_routes()
        self.passed("Real admin OTP login and same-origin API access")

        name = "CI route " + uuid.uuid4().hex[:10]
        self.page.get_by_role("button", name="Новый маршрут", exact=True).click()
        self.page.get_by_label("Название нового маршрута", exact=True).fill(name)
        self.page.get_by_label("Валюта нового маршрута", exact=True).select_option("KZT")
        self.page.get_by_label("Тариф нового маршрута", exact=True).fill("500")
        with self.response_for("/admin/routes", "POST") as pending:
            self.page.get_by_role("button", name="Создать маршрут", exact=True).click()
        require(pending.value.status == 201, "Route creation must use the actual API")
        created = pending.value.json()["route"]
        self.route_id = created["id"]
        self.expect(self.page.get_by_role("heading", name=name, level=2, exact=True)).to_be_visible()
        stops = [("A", "QA питак A", "42.9", "71.3"), ("C", "QA остановка C", "", ""), ("B", "QA питак B", "42.94", "71.43")]
        for index, (code, stop_name, lat, lng) in enumerate(stops, 1):
            self.page.get_by_role("button", name="Добавить остановку", exact=True).click()
            for label, value in [("Код", code), ("Название", stop_name), ("Широта", lat), ("Долгота", lng)]:
                self.page.get_by_label(f"{label} остановки {index}", exact=True).fill(value)
        self.page.get_by_role("button", name="Опустить остановку 2", exact=True).click()
        self.expect(self.page.get_by_label("Код остановки 2", exact=True)).to_have_value("B")
        self.expect(self.page.get_by_label("Код остановки 3", exact=True)).to_have_value("C")
        self.page.get_by_role("button", name="Поднять остановку 3", exact=True).click()
        self.expect(self.page.get_by_label("Код остановки 2", exact=True)).to_have_value("C")
        self.page.get_by_role("button", name="Добавить остановку", exact=True).click()
        self.expect(self.page.get_by_label("Код остановки 4", exact=True)).to_be_visible()
        self.page.get_by_role("button", name="Удалить остановку 4", exact=True).click()
        self.expect(self.page.get_by_label("Код остановки 4", exact=True)).to_have_count(0)
        self.choose_on_map(1, apply=False)
        self.passed("Closing an actual clicked map candidate retains the original stop coordinates without saving")
        self.choose_on_map(1, "desktop-map-pitak-a")
        self.choose_on_map(2, "desktop-map-middle-stop")
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.choose_on_map(3, "mobile-390-map-pitak-b")
        require(self.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "390px map picker must not overflow horizontally")
        self.page.set_viewport_size({"width": 1440, "height": 1000})
        self.passed("Real OSM map clicks select pitaks A/B and a middle stop on desktop and 390px mobile")
        self.page.get_by_role("checkbox", name="Настроить питаки A/B", exact=True).check()
        self.page.get_by_label("Питак A", exact=True).select_option(label="1. QA питак A")
        self.page.get_by_label("Питак B", exact=True).select_option(label="3. QA питак B")
        self.page.get_by_label("Радиус питака, м", exact=True).fill("175")
        save = self.page.get_by_role("button", name="Сохранить остановки и питаки", exact=True)
        layout_path = "/admin/routes/" + self.route_id + "/layout"
        with self.response_for(layout_path, "PUT") as pending:
            save.click()
        require(pending.value.status == 200, "The UI layout save must commit through the actual API")
        saved = pending.value.json()["route"]
        self.expect(self.page.get_by_role("status").filter(has_text="Остановки и питаки A/B сохранены.")).to_be_visible()
        self.assert_layout(saved)
        require(saved["pricePerStopKzt"] == created["pricePerStopKzt"] and saved["active"] == created["active"], "Layout must retain existing fare and metadata")
        require(self.route() == saved, "A separate API read must return the committed layout")
        self.assert_form(saved)
        self.screenshot("desktop-saved")
        self.passed("Create route, save map-selected A/C/B geometry, select pitaks/radius and retain metadata")

        self.page.reload(wait_until="domcontentloaded")
        self.expect(self.page.get_by_role("heading", name="Вход в панель", exact=True)).to_be_visible()
        self.login()
        self.open_routes()
        # The newly created route may already be first in the sorted catalog.
        # Select it, await its form, then require a fresh explicit GET rather
        # than waiting for a change event that a same-value select cannot emit.
        self.page.get_by_label("Маршрут", exact=True).select_option(self.route_id)
        self.assert_form(saved)
        with self.response_for("/admin/routes/" + self.route_id, "GET") as pending:
            self.page.get_by_role("button", name="Загрузить текущую версию", exact=True).click()
        require(pending.value.status == 200, "Reloaded UI must load the durable route")
        require(pending.value.json()["route"] == saved, "Browser reload must preserve durable IDs, geometry and pitaks")
        self.assert_form(saved)
        self.screenshot("desktop-reloaded")
        self.passed("Browser reload, fresh OTP login and durable layout restoration")

        request_count = len(self.layout_requests)
        self.page.get_by_label("Широта остановки 1", exact=True).fill("91")
        save.click()
        self.expect(self.page.get_by_role("alert").filter(has_text="широта: допустимо число")).to_be_visible()
        require(len(self.layout_requests) == request_count, "Invalid UI geometry must never send a layout write")
        require(self.route() == saved, "Invalid coordinates must leave the durable route unchanged")
        self.expect(self.page.get_by_label("Широта остановки 1", exact=True)).to_have_value("91")
        self.screenshot("desktop-invalid-coordinates")
        self.page.get_by_label("Широта остановки 1", exact=True).fill(str(saved["stops"][0]["location"]["lat"]))
        self.passed("Invalid coordinates show a UI error and retain the draft without a write")

        dirty_name = "Несохранённый черновик C"
        self.page.get_by_label("Название остановки 2", exact=True).fill(dirty_name)
        changed = expect_status(api_request(self.args.api_url, "/admin/routes/" + self.route_id, method="PATCH", body={"name": name + " · server update"}, token=self.token), 200, "Concurrent real metadata update")["route"]
        require(changed["updatedAt"] > saved["updatedAt"] and changed["stops"] == saved["stops"], "Concurrent metadata write must advance the version and retain geometry")
        self.expected_conflict_path = "/api" + layout_path
        with self.response_for(layout_path, "PUT") as pending:
            save.click()
        response = pending.value
        require(response.status == 409 and response.json().get("error", {}).get("code") == "ROUTE_CHANGED", "Dirty stale draft must receive an actual ROUTE_CHANGED conflict")
        self.conflict_observed = True
        self.expect(self.page.get_by_text("Маршрут изменился на сервере.", exact=True)).to_be_visible()
        self.expect(self.page.get_by_label("Название остановки 2", exact=True)).to_have_value(dirty_name)
        self.expect(save).to_be_disabled()
        require(self.route() == changed, "Rejected draft must not overwrite server data")
        self.screenshot("desktop-conflict-draft-retained")
        self.page.get_by_role("button", name="Загрузить текущую версию", exact=True).first.click()
        self.expect(self.page.get_by_text("Загрузка заменит ваш несохранённый черновик данными с сервера.", exact=True)).to_be_visible()
        self.expect(self.page.get_by_label("Название остановки 2", exact=True)).to_have_value(dirty_name)
        with self.response_for("/admin/routes/" + self.route_id, "GET") as pending:
            self.page.get_by_role("button", name="Загрузить и заменить черновик", exact=True).click()
        require(pending.value.status == 200, "Explicit reload must fetch the actual server route")
        self.assert_form(changed)
        self.expect(save).to_be_disabled()
        self.expect(self.page.get_by_text("Маршрут изменился на сервере.", exact=True)).to_have_count(0)
        self.passed("Actual metadata conflict returns 409, retains dirty draft, and requires explicit replacement")

        self.page.set_viewport_size({"width": 390, "height": 844})
        self.identity()
        self.assert_form(changed)
        require(self.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "390px admin editor must not overflow horizontally")
        heading = self.page.get_by_role("heading", name=changed["name"], level=2, exact=True).bounding_box()
        require(heading is not None and heading["width"] >= 200, "Mobile route name needs readable width beside or above its reload action")
        self.page.evaluate("window.scrollTo(0, 0)")
        self.screenshot("mobile-390-layout")
        self.passed("390px mobile editor renders persisted coordinates and pitaks without horizontal overflow")

        phone = "+77779" + str(uuid.uuid4().int % 1_000_000).zfill(6)
        challenge = expect_status(api_request(self.args.api_url, "/auth/request-otp", method="POST", body={"phone_number": phone, "full_name": "CI passenger", "role": "passenger", "locale": "ru"}), 202, "Real passenger OTP")
        passenger = expect_status(api_request(self.args.api_url, "/auth/verify-otp", method="POST", body={"phone_number": phone, "code": challenge["demo_code"]}), 200, "Real passenger authentication")
        denied = expect_status(api_request(self.args.api_url, "/admin/routes/" + self.route_id, token=passenger["access_token"]), 403, "Passenger admin read denied")
        require(denied.get("error", {}).get("code") == "FORBIDDEN", "Passenger read must fail server-side role authorization")
        denied = expect_status(api_request(self.args.api_url, layout_path, method="PUT", body={"expected_updated_at": changed["updatedAt"], "stops": []}, token=passenger["access_token"]), 403, "Passenger layout write denied")
        require(denied.get("error", {}).get("code") == "FORBIDDEN", "Passenger write must fail server-side role authorization")
        require(self.route() == changed, "Passenger request must not mutate the route")
        self.passed("Real passenger tokens cannot read or write admin routes")

        self.currency_tariffs(passenger["access_token"])
        self.vehicle_review()
        self.audit_journal(passenger["access_token"])
        self.admin_orders(passenger["access_token"])

        with self.response_for("/auth/logout", "POST") as pending:
            self.page.get_by_role("button", name="Выйти", exact=True).click()
        require(pending.value.status == 204, "UI logout must invalidate the real backend session")
        self.expect(self.page.get_by_role("heading", name="Вход в панель", exact=True)).to_be_visible()
        expect_status(api_request(self.args.api_url, "/admin/routes/" + self.route_id, token=self.token), 401, "Logged-out token rejected")
        self.expect(self.page.get_by_test_id("admin-audit-journal")).to_have_count(0)
        self.expect(self.page.get_by_test_id("admin-orders")).to_have_count(0)
        self.expect(self.page.get_by_test_id("admin-monitoring")).to_have_count(0)
        self.expect(self.page.get_by_test_id("monitor-snapshot")).to_have_count(0)
        self.screenshot("mobile-390-logged-out")
        self.passed("UI logout returns to login and invalidates the admin token")
        self.assert_console_health()
        self.passed("No unexpected browser console errors, page errors or framework overlays")

    def assert_console_health(self):
        errors = []
        for entry in self.console:
            if entry["type"] != "error":
                continue
            # Chromium reports the deliberately rejected HTTP request as a
            # resource error. Allow only that exact endpoint/status after its
            # real 409 response was verified; application errors still fail.
            expected = self.conflict_observed and urlparse(entry["url"]).path == self.expected_conflict_path and bool(re.fullmatch(r"Failed to load resource: the server responded with a status of 409 \(Conflict\)", entry["text"]))
            expected_vehicle = self.vehicle_conflict_observed and urlparse(entry["url"]).path == self.vehicle_conflict_path and bool(re.fullmatch(r"Failed to load resource: the server responded with a status of 409 \(Conflict\)", entry["text"]))
            expected_audit = self.audit_network_failure and urlparse(entry["url"]).path == "/api/admin/audit-events" and bool(re.fullmatch(r"Failed to load resource: net::ERR_CONNECTION_FAILED", entry["text"]))
            expected_order_conflict = urlparse(entry["url"]).path in self.order_conflict_paths and bool(re.fullmatch(r"Failed to load resource: the server responded with a status of 409 \(Conflict\)", entry["text"]))
            expected_order_network = self.order_network_failure_path and urlparse(entry["url"]).path == self.order_network_failure_path and bool(re.fullmatch(r"Failed to load resource: net::ERR_CONNECTION_FAILED", entry["text"]))
            expected_monitor = self.monitor_network_failure and urlparse(entry["url"]).path == "/api/admin/queue" and bool(re.fullmatch(r"Failed to load resource: net::ERR_CONNECTION_FAILED", entry["text"]))
            if not expected and not expected_vehicle and not expected_audit and not expected_order_conflict and not expected_order_network and not expected_monitor:
                errors.append(entry)
        require(not errors and not self.page_errors, f"Browser errors: {redact(errors)}; page errors: {self.page_errors}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:4173")
    parser.add_argument("--api-url", default="http://127.0.0.1:5000")
    parser.add_argument("--admin-phone", default=os.environ.get("ADMIN_PHONE"))
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/admin-layout-qa"))
    args = parser.parse_args()
    require(os.environ.get("NODE_ENV") in {"test", "development"}, "This QA requires the CI-only nonproduction OTP configuration")
    require(bool(args.admin_phone), "ADMIN_PHONE must match the CI API's test administrator")
    for origin in [args.base_url, args.api_url]:
        parsed = urlparse(origin)
        require(parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"} and parsed.path in {"", "/"}, "QA URLs must address the local CI services")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = {"status": "failed", "environment": {"base_url": args.base_url, "api_url": args.api_url, "browser": "Chromium / Python Playwright", "browser_plugin": "not available", "viewports": [{"width": 1440, "height": 1000}, {"width": 390, "height": 844}]}, "checks": []}
    qa = None
    exit_code = 1
    try:
        from playwright.sync_api import expect, sync_playwright
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="ru-RU")
            page = context.new_page()
            page.set_default_timeout(15_000)
            qa = AdminLayoutQA(args, page, expect)
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
            report["checks"] = qa.checks
            report["route_id"] = qa.route_id
            report["page_errors"] = qa.page_errors
            report["map_tiles"] = qa.map_tiles
            report["map_selections"] = qa.map_selections
            (args.output_dir / "console.log").write_text("\n".join(json.dumps(entry, ensure_ascii=False) for entry in qa.console) + "\n", encoding="utf-8")
        report["screenshots"] = sorted(file.name for file in args.output_dir.glob("*.png"))
        (args.output_dir / "verification.json").write_text(json.dumps(redact(report), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())



