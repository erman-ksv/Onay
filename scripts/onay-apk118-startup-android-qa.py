#!/usr/bin/env python3
"""Cold-launch Android 12+ native/JS splash QA with real MP4 capture; no Metro or backend."""
import argparse
import importlib.util
import json
import re
import subprocess
import time
from pathlib import Path

spec=importlib.util.spec_from_file_location("onay_adb",Path(__file__).with_name("onay-android-apk-smoke.py"))
if not spec or not spec.loader: raise RuntimeError("ADB helper missing")
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)

LOCALES=("ru","uz","kk")
def dump(out,label):
    h.screenshot(out,label)
    h.xml_snapshot(out,label)

def tap_demo():
    h.await_node("onay-auth-demo","id",timeout=90)
    h.click("onay-auth-demo","id")
    h.await_node("onay-demo-app","id",timeout=45)

def cold_launch_record(out,name):
    # The recorder starts before the actual Activity launch. Nothing delays the app's own loading.
    remote=f"/sdcard/{name}.mp4"
    h.adb("shell","am","force-stop","uz.tezjet.app")
    h.adb("shell","rm","-f",remote)
    proc=subprocess.Popen(["adb","shell","screenrecord","--bit-rate","2000000","--time-limit","15",remote],
                          stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        time.sleep(1.0)  # Recorder startup, not an application loading delay.
        h.adb("shell","monkey","-p","uz.tezjet.app","-c","android.intent.category.LAUNCHER","1",timeout=45)
        h.await_node("onay-auth-demo","id",timeout=90)
        time.sleep(2.2)  # Preserve a readable final auth frame in QA video.
    finally:
        h.adb("shell","pkill","-2","screenrecord",check=False)
        try:proc.communicate(timeout=20)
        except subprocess.TimeoutExpired:proc.kill();proc.communicate()
    local=out/f"{name}.mp4"
    h.adb("pull",remote,str(local),timeout=60)
    if not local.is_file() or local.stat().st_size<10000:
        raise AssertionError(f"Real Android startup video invalid: {local}")
    return local

def no_white_flash(video):
    """Reject a bright blank frame AFTER Onay dark native/JS has first appeared."""
    cmd=["ffmpeg","-v","error","-i",str(video),"-vf","fps=6,scale=64:112",
         "-f","rawvideo","-pix_fmt","rgb24","-"]
    raw=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=70,check=True).stdout
    size=64*112*3
    if len(raw)//size < 4: raise AssertionError("Not enough frames to verify white flash")
    saw_dark=False
    frames=0
    for start in range(0,len(raw)-size+1,size):
        frame=raw[start:start+size];frames+=1
        # Ignore launcher/status regions; focus on central app area.
        middle=frame[(30*64*3):(85*64*3)]
        total=len(middle)//3
        bright=sum(1 for i in range(0,len(middle),3) if min(middle[i:i+3])>=235)
        dark=sum(1 for i in range(0,len(middle),3) if middle[i]<65 and middle[i+1]<85 and middle[i+2]<80)
        if dark/total>0.40: saw_dark=True
        if saw_dark and bright/total>0.80:
            raise AssertionError(f"White blank flash found in actual Android video at sampled frame {frames}")
    if not saw_dark: raise AssertionError("Native/JS dark branded frame never observed in startup video")
    return frames

def selected_language(lang):
    node=h.await_node("onay-language-"+lang,"id")
    if node.attrib.get("checked")!="true" and node.attrib.get("selected")!="true":
        raise AssertionError(f"Language {lang} not selected in installed Android: {node.attrib}")

def check_language(out,lang,report):
    tap_demo()
    h.click("onay-tab-profile","id")
    h.await_node("onay-passenger-profile-panel","id")
    h.click("onay-language-"+lang,"id")
    selected_language(lang)
    dump(out,"language-"+lang+"-set")
    movie=cold_launch_record(out,"cold-start-"+lang)
    report["videos"].append(movie.name)
    report["checks"].append(f"{lang} actual Android cold-start video, {no_white_flash(movie)} decoded frames, no white blank flash")
    tap_demo()
    h.click("onay-tab-profile","id")
    selected_language(lang)
    dump(out,"language-"+lang+"-restored")
    report["checks"].append(f"{lang} selection survived force-stop/restart")

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--old-apk",required=True,type=Path)
    p.add_argument("--new-apk",required=True,type=Path)
    p.add_argument("--output",required=True,type=Path)
    p.add_argument("--old-version",type=int,default=117)
    p.add_argument("--new-version",type=int,default=118)
    args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    report={"status":"failed","checks":[],"failures":[],"videos":[]}
    try:
        h.wait_for_healthy_android()
        api=int(h.adb("shell","getprop","ro.build.version.sdk").strip())
        assert api>=31,f"Android 12+ required, SDK={api}"
        report["checks"].append(f"Android SDK={api} (system splash)")
        h.install_exact(args.old_apk,args.old_version,args.output,"apk-old")
        h.install_exact(args.new_apk,args.new_version,args.output,"apk-new")
        report["checks"].append(f"In-place update {args.old_version} to {args.new_version}; no uninstall/clear")
        # Verify on a cold launch first, before demo ever opens.
        movie=cold_launch_record(args.output,"cold-start-upgraded")
        report["videos"].append(movie.name)
        report["checks"].append(f"Cold-launch update no Metro: {no_white_flash(movie)} sampled video frames")
        for lang in LOCALES:
            check_language(args.output,lang,report)
        # Small display viewport ~320dp. Keep it within Android system navigation insets.
        h.adb("shell","wm","size","640x1280")
        h.adb("shell","wm","density","320")
        try:
            h.adb("shell","am","force-stop","uz.tezjet.app")
            h.adb("shell","monkey","-p","uz.tezjet.app","-c","android.intent.category.LAUNCHER","1",timeout=40)
            tap_demo()
            dump(args.output,"small-screen-320dp")
            report["checks"].append("Small Android display 320dp launched without clipped root")
        finally:
            h.adb("shell","wm","size","reset")
            h.adb("shell","wm","density","reset")
        # Offline demo remains reachable with wifi/mobile data disabled.
        h.adb("shell","svc","wifi","disable")
        h.adb("shell","svc","data","disable")
        try:
            h.adb("shell","am","force-stop","uz.tezjet.app")
            h.adb("shell","monkey","-p","uz.tezjet.app","-c","android.intent.category.LAUNCHER","1",timeout=40)
            tap_demo()
            dump(args.output,"offline-demo-available")
            report["checks"].append("Cold offline start without SMS/Metro reaches native demo")
        finally:
            h.adb("shell","svc","wifi","enable")
            h.adb("shell","svc","data","enable")
        report["status"]="passed"
    except Exception as exc:
        report["failures"].append(repr(exc))
        try:dump(args.output,"startup-android-failure")
        except Exception as e:report["failures"].append("Screenshot: "+repr(e))
    finally:
        (args.output/"startup-verification.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
        print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
    if report["status"]!="passed":raise SystemExit(1)
if __name__=="__main__":main()
