#!/usr/bin/env python3
"""Android QA: installed APK114 -> one final PR110 APK, no Metro or backend."""
import argparse,json,importlib.util
from pathlib import Path
p=Path(__file__).with_name("onay-android-apk-smoke.py")
spec=importlib.util.spec_from_file_location("onay_helpers",p)
if spec is None or spec.loader is None: raise RuntimeError("Android smoke helpers unavailable")
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)

def record(out,name):
 h.screenshot(out,name);h.xml_snapshot(out,name)

def verify_personal_details(version_code,out):
 # APK115 source5c9f940 has the static identity modal; standalone/email was
 # introduced later for APK116. Never accept a legacy page for APK116.
 if version_code == 115:
  h.await_node("onay-profile-personal-details","id")
  name=h.await_node("onay-profile-personal-name","id")
  if name.attrib.get("text") != "Демо-пассажир" or name.attrib.get("class") != "android.widget.TextView":
   raise AssertionError("APK115 must show its read-only demo account name")
  h.await_node("Данные сохранены при регистрации. Если их нужно изменить, обратитесь в поддержку.","text")
  support=h.await_node("onay-personal-support","id")
  if support.attrib.get("clickable") != "true":
   raise AssertionError("APK115 personal support action is unavailable")
  record(out,"android-personal-data-apk115-readonly-identity")
 elif version_code == 116:
  h.await_node("onay-personal-details-screen","id")
  h.await_node("onay-profile-personal-email","id")
  h.await_node("Не хранится отдельно")
  record(out,"android-personal-data-readonly-email")
 else:
  raise ValueError("No verified personal-details contract for APK"+str(version_code))

def verify_personal_navigation(version_code,out):
 if version_code not in (115,116):
  raise ValueError("No verified personal-details contract for APK"+str(version_code))
 h.click("onay-profile-personal-data","id")
 verify_personal_details(version_code,out)
 h.click("onay-screen-back","id")
 h.await_node("onay-passenger-profile-panel","id")
 h.click("onay-profile-personal-data","id")
 h.adb("shell","input","keyevent","4")
 h.await_node("onay-passenger-profile-panel","id")
 record(out,"android-personal-data-android-back")
 return "APK115 read-only identity/support and both Back paths" if version_code == 115 else "Personal details read-only identity, disabled demo email and both Back paths"

def main():
 parser=argparse.ArgumentParser()
 parser.add_argument("--old-apk",type=Path,required=True)
 parser.add_argument("--new-apk",type=Path,required=True)
 parser.add_argument("--old-version-code",type=int,default=114)
 parser.add_argument("--version-code",type=int,choices=(115,116),required=True)
 parser.add_argument("--output",type=Path,required=True)
 a=parser.parse_args();a.output.mkdir(parents=True,exist_ok=True)
 result={"status":"failed","checks":[],"failures":[]}
 try:
  h.wait_for_healthy_android()
  # APK114 has the legacy personal-data page: never assert APK116-only controls before upgrade.
  h.install_exact(a.old_apk,a.old_version_code,a.output,f"apk{a.old_version_code}")
  result["checks"].append(f"Installed legacy versionCode={a.old_version_code} via ADB")
  h.open_demo()
  h.click("onay-tab-profile","id")
  h.await_node("onay-passenger-profile-panel","id")
  h.click("onay-profile-personal-data","id")
  h.await_node("onay-profile-personal-details","id")
  record(a.output,f"android-legacy-personal-apk{a.old_version_code}")
  # Upgrade in place; assert only the pinned artifact version's personal-data contract.
  h.install_exact(a.new_apk,a.version_code,a.output,f"apk{a.version_code}")
  result["checks"].append(f"Upgraded to versionCode={a.version_code} via ADB")
  h.open_demo()
  h.click("onay-tab-profile","id")
  h.await_node("onay-passenger-profile-panel","id")
  result["checks"].append(verify_personal_navigation(a.version_code,a.output))
  h.click("onay-profile-driver","id")
  h.await_node("onay-driver-mode-overview","id")
  h.await_node("Учебные статусы")
  record(a.output,"android-driver-overview-unfilled")
  for state,label in [("pending","На проверке"),("approved","Подтверждено"),("rejected","Отклонено"),("blocked","Заблокировано")]:
   h.click("onay-driver-mode-demo-"+state,"id")
   h.await_node(label)
   record(a.output,"android-driver-overview-demo-"+state)
  h.adb("shell","input","swipe","500","1400","500","370","330")
  record(a.output,"android-driver-overview-scroll-bottom")
  root,_=h.ui_tree()
  if h.find_node(root,"onay-driver-mode-enter","id") is not None:raise AssertionError("Demo UI offered real driver activation")
  h.click("onay-screen-back","id")
  h.await_node("onay-passenger-profile-panel","id")
  record(a.output,"android-driver-overview-arrow-back")
  h.click("onay-profile-driver","id")
  h.await_node("onay-driver-mode-overview","id")
  h.adb("shell","input","keyevent","4")
  h.await_node("onay-passenger-profile-panel","id")
  record(a.output,"android-driver-overview-hardware-back")
  result["checks"].append("Driver overview demo, arrow Back, Android Back returned to passenger")
  h.click("onay-demo-role-driver","id")
  h.click("onay-driver-tab-chats","id")
  h.await_node("Чаты с пассажирами пока недоступны")
  root,_=h.ui_tree()
  if h.find_node(root,"onay-chats-inner-heading","id") is not None:raise AssertionError("Duplicate chat heading visible")
  if h.find_node(root,"Переписка с водителем") is not None:raise AssertionError("Passenger-specific text visible in driver chats")
  record(a.output,"android-driver-chats-dark")
  h.click("onay-driver-tab-profile","id")
  h.click("onay-driver-theme-light","id")
  h.click("onay-driver-tab-chats","id")
  h.await_node("Чаты с пассажирами пока недоступны")
  record(a.output,"android-driver-chats-light")
  result["checks"].append("Driver chats correct in dark and light themes, no duplicate title")
  result["status"]="passed"
 except Exception as e:
  result["failures"].append(repr(e))
  try:record(a.output,"android-failure")
  except Exception as d:result["failures"].append("screenshot: "+repr(d))
 finally:
  (a.output/"verification.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n")
  print(json.dumps(result,ensure_ascii=False,indent=2))
 if result["status"]!="passed":raise SystemExit(1)
if __name__=="__main__":main()
