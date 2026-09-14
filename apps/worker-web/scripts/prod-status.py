#!/usr/bin/env python3
"""生产环境状态汇总:SAE 实例状态 + 排名数据。"""
import json
import subprocess

R = "cn-hangzhou"
APIID = "878a6fb6-c546-4561-8afa-72c84e649a33"
DBID = "d4887b28-50b8-486e-b003-0b02c73c4c34"
WKID = "ffd157f3-36b3-4e7c-b998-af2fa9049a27"
WEBID = "b897a60c-a4e7-4b79-b71b-612cf367a69d"
TOKEN = open("/tmp/prod-token").read().strip()


def sae(api, *extra):
    r = subprocess.run(["aliyun", "sae", api, "--RegionId", R, *extra], capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {}


apps = {"geo-db": DBID, "geo-api": APIID, "geo-worker": WKID, "geo-web": WEBID}
for name, appid in apps.items():
    st = sae("DescribeApplicationStatus", "--AppId", appid)
    data = st.get("Data") or {}
    print(f"{name}: {data.get('CurrentStatus')}")

g = sae("DescribeApplicationGroups", "--AppId", APIID)
gdata = g.get("Data")
gid = gdata[0]["GroupId"] if isinstance(gdata, list) and gdata else ""
ins = sae("DescribeApplicationInstances", "--AppId", APIID, "--GroupId", gid) if gid else {}
idata = (ins.get("Data") or {}).get("Instances", [])
for i in idata:
    print("geo-api container:", i.get("InstanceContainerStatus"), "| restarts:", i.get("InstanceContainerRestarts"))
