#!/usr/bin/env python3
"""拉取四个应用的实例状态与日志(SLS)。"""
import json
import subprocess
import sys
import time

R = "cn-hangzhou"

APPS = {
    "geo-db": "d4887b28-50b8-486e-b003-0b02c73c4c34",
    "geo-api": "878a6fb6-c546-4561-8afa-72c84e649a33",
    "geo-worker": "ffd157f3-36b3-4e7c-b998-af2fa9049a27",
    "geo-web": "b897a60c-a4e7-4b79-b71b-612cf367a69d",
}


def sae(api, *extra):
    r = subprocess.run(["aliyun", "sae", api, "--RegionId", R, *extra], capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except Exception:
        print("  [sae error]", (r.stdout + r.stderr)[:150])
        return {}


for name, appid in APPS.items():
    print(f"=== {name} ===")
    g = sae("DescribeApplicationGroups", "--AppId", appid)
    gdata = g.get("Data")
    gid = gdata[0]["GroupId"] if isinstance(gdata, list) and gdata else ""
    if not gid:
        print("  no group")
        continue
    ins = sae("DescribeApplicationInstances", "--AppId", appid, "--GroupId", gid)
    idata = (ins.get("Data") or {}).get("Instances", [])
    if not idata:
        print("  no instances")
        continue
    for i in idata:
        iid = i.get("InstanceId")
        print("  instance:", iid, "|", i.get("InstanceContainerStatus"),
              "| restarts:", i.get("InstanceContainerRestarts"),
              "| ip:", i.get("InstanceContainerIp"))
        for attempt in range(3):
            log = sae("DescribeInstanceLog", "--InstanceId", iid)
            content = (log.get("Data") or "")
            if content:
                print("  --- log tail ---")
                print("  " + content[-800:].replace("\n", "\n  "))
                break
            time.sleep(3)
        else:
            print("  log: (空,可能采集链路尚未就绪)")
