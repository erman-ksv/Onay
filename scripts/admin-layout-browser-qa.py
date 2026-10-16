#!/usr/bin/env python3
"""Real admin layout QA against the CI API/PostgreSQL and Vite dev proxy.

Browser plugin not available; this explicit CI task uses Python Playwright.
No requests are intercepted or mocked. CI's nonproduction NODE_ENV exposes the existing
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
        self.expect(self.page).to_have_title("Onay — администрирование")
        self.expect(self.page.locator("#root")).not_to_be_empty()
        require(self.page.locator("vite-error-overlay, nextjs-portal, [data-nextjs-dialog-overlay]").count() == 0, "Framework error overlay is visible")

    def wait_for_otp_cooldown(self):
        if self.last_otp_accepted_at is None:
            return
        cooldown_seconds = int(os.environ.get("ONAY_OTP_RESEND_SECONDS", os.environ.get("TEZJET_OTP_RESEND_SECONDS", "60")))
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

    def run(self):
        expect_status(api_request(self.args.api_url, "/healthz"), 200, "Actual API health")
        expect_status(api_request(self.args.base_url, "/healthz"), 200, "Vite development API proxy health")
        self.page.goto(self.args.base_url.rstrip("/") + "/admin", wait_until="domcontentloaded")
        self.login()
        self.open_routes()
        self.passed("Real admin OTP login and same-origin API proxy")

        name = "CI route " + uuid.uuid4().hex[:10]
        self.page.get_by_role("button", name="Новый маршрут", exact=True).click()
        self.page.get_by_label("Название нового маршрута", exact=True).fill(name)
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

        with self.response_for("/auth/logout", "POST") as pending:
            self.page.get_by_role("button", name="Выйти", exact=True).click()
        require(pending.value.status == 204, "UI logout must invalidate the real backend session")
        self.expect(self.page.get_by_role("heading", name="Вход в панель", exact=True)).to_be_visible()
        expect_status(api_request(self.args.api_url, "/admin/routes/" + self.route_id, token=self.token), 401, "Logged-out token rejected")
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
            if not expected:
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
