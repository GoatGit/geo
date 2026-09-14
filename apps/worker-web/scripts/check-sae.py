#!/usr/bin/env python3
"""检查 geo-* 四个应用的实例状态 + SLB 绑定。"""
import json
import subprocess

R = "cn-hangzhou"
VPC = "vpc-bp1ioagqblkgjyek6nirf"
VS = "vsw-bp1mlk3jt47sa0tc2mdx3"
SG = "sg-bp19b1oh9sjwn9bsagdy"
ACR = "crpi-fgbi72bokijrd5cd.cn-hangzhou.personal.cr.aliyuncs.com/gemux"
IMAGE = f"{ACR}/geo:v1"
API_CLB = "lb-bp1mvgmf93k1v1np5h3v0"
WEB_CLB = "lb-bp1et6hr0rwcsf1t6fffn"

APPS = {
    "geo-api": "878a6fb6-c546-4561-8afa-72c84e649a33",
    "geo-worker": "ffd157f3-36b3-4e7c-b998-af2fa9049a27",
    "geo-web": "b897a60c-a4e7-4b79-b71b-612cf367a69d",
}


def sae(api, *extra):
    r = subprocess.run(["aliyun", "sae", api, "--RegionId", R, *extra], capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except Exception:
        print(f"  [sae {api} error]", (r.stdout + r.stderr)[:150])
        return {}


# 1. 各应用实例状态
for name, app_id in APPS.items():
    d = sae("DescribeApplicationGroups", "--AppId", app_id)
    data = d.get("Data")
    gid = data[0]["GroupId"] if isinstance(data, list) and data else ""
    if not gid:
        print(f"{name}: no group")
        continue
    ins = sae("DescribeApplicationInstances", "--AppId", app_id, "--GroupId", gid)
    idata = (ins.get("Data") or {}).get("Instances", [])
    if not idata:
        print(f"{name}: no instances")
        continue
    for i in idata:
        print(f"{name}: {i.get('InstanceContainerStatus')} | ip={i.get('InstanceContainerIp')} "
              f"| restarts={i.get('InstanceContainerRestarts')}")

# 2. SLB 绑定状态
for name, app_id in APPS.items():
    d = sae("DescribeApplicationSlbs", "--AppId", app_id)
    data = (d.get("Data") or {})
    print(f"{name} internet: {json.dumps(data.get('Internet'))[:150]}")
    print(f"{name} intranet: {json.dumps(data.get('Intranet'))[:150]}")
