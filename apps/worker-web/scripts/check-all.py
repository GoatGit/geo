#!/usr/bin/env python3
"""检查 geo-* 四个应用的实例状态。"""
import json
import subprocess

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
        print("  [sae error]", (r.stdout + r.stderr)[:120])
        return {}


for name, appid in APPS.items():
    d = sae("DescribeApplicationStatus", "--AppId", appid)
    status = (d.get("Data") or {}).get("CurrentStatus")
    g = sae("DescribeApplicationGroups", "--AppId", appid)
    gdata = g.get("Data")
    gid = gdata[0]["GroupId"] if isinstance(gdata, list) and gdata else ""
    idata = []
    if gid:
        ins = sae("DescribeApplicationInstances", "--AppId", appid, "--GroupId", gid)
        idata = (ins.get("Data") or {}).get("Instances", [])
    cs = [i.get("InstanceContainerStatus") for i in idata]
    print(f"{name}: app={status} containers={cs}")
