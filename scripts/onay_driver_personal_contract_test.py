"""Exercise versioned Android QA assertions without launching an emulator."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("driver_qa", Path(__file__).with_name("onay-driver-mode-chats-android-qa.py"))
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


class NativeFixture:
    def __init__(self, version, missing=None, name="Демо-пассажир", broken_back=None):
        self.version, self.missing, self.name, self.broken_back = version, missing, name, broken_back
        self.personal = False
        self.actions, self.assertions = [], []

    def click(self, query, mode="any"):
        self.actions.append(query)
        if query == "onay-profile-personal-data":
            self.personal = True
        elif query == "onay-screen-back" and self.broken_back != "arrow":
            self.personal = False

    def adb(self, *args):
        assert args == ("shell", "input", "keyevent", "4")
        self.actions.append("hardware-back")
        if self.broken_back != "hardware":
            self.personal = False

    def await_node(self, query, mode="any"):
        self.assertions.append(query)
        if query == "onay-passenger-profile-panel":
            assert not self.personal, "Back did not return to profile"
        else:
            assert self.personal, "Personal page was not opened"
            allowed = ({"onay-profile-personal-details", "onay-profile-personal-name", "onay-personal-support",
                        "Данные сохранены при регистрации. Если их нужно изменить, обратитесь в поддержку."}
                       if self.version == 115 else
                       {"onay-personal-details-screen", "onay-profile-personal-email", "Не хранится отдельно"})
            assert query in allowed and query != self.missing, "Required native contract is missing: " + query
        return SimpleNamespace(attrib={"text": self.name, "class": "android.widget.TextView", "clickable": "true"})


class ContractTests(unittest.TestCase):
    def run_fixture(self, version, fixture):
        with patch.object(qa, "h", fixture), patch.object(qa, "record"):
            return qa.verify_personal_navigation(version, Path("unused"))

    def test_both_versions_require_arrow_and_hardware_back(self):
        for version in (115, 116):
            with self.subTest(version=version):
                fixture = NativeFixture(version)
                self.run_fixture(version, fixture)
                self.assertEqual(fixture.actions, ["onay-profile-personal-data", "onay-screen-back", "onay-profile-personal-data", "hardware-back"])
                self.assertEqual(fixture.assertions.count("onay-passenger-profile-panel"), 2)

    def test_115_requires_real_readonly_identity_and_support(self):
        for options in ({"missing": "onay-profile-personal-name"}, {"missing": "onay-personal-support"}, {"name": "Wrong account"}):
            with self.subTest(options=options), self.assertRaises(AssertionError):
                self.run_fixture(115, NativeFixture(115, **options))

    def test_116_rejects_legacy_page_and_missing_email(self):
        for fixture in (NativeFixture(115), NativeFixture(116, missing="onay-profile-personal-email")):
            with self.subTest(fixture=fixture), self.assertRaises(AssertionError):
                self.run_fixture(116, fixture)

    def test_broken_back_is_failure_in_each_contract(self):
        for version in (115, 116):
            for back in ("arrow", "hardware"):
                with self.subTest(version=version, back=back), self.assertRaises(AssertionError):
                    self.run_fixture(version, NativeFixture(version, broken_back=back))

    def test_unknown_artifact_fails_before_interaction(self):
        fixture = NativeFixture(119)
        with self.assertRaises(ValueError):
            self.run_fixture(119, fixture)
        self.assertEqual(fixture.actions, [])


if __name__ == "__main__":
    unittest.main()
