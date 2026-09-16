#!/usr/bin/env python3
"""拉取 geo-worker 运行实例的完整日志(SLS)。用法: python3 worker-log.py [> 文件]""",
import json, subprocess
R = "cn-hangzhou"
def sae(api, *extra):
    r = subprocess.run(["aliyun", "sae", api, "--RegionId", R, *extra], capture_output=True, text=True)
    try: return json.loads(r.stdout)
    except Exception: return {}
APP = "ffd157f3-36b3-4e7c-b998-af2fa9049a27"
g = sae("DescribeApplicationGroups", "--AppId", APP).get("Data") or []
gid = g[0]["GroupId"] if g else ""
ins = sae("DescribeApplicationInstances", "--AppId", APP, "--GroupId", gid).get("Data") or {}
running = [i for i in ins.get("Instances", []) if i.get("InstanceContainerStatus") == "Running"]
if not running:
    print("no running worker instance"); raise SystemExit
iid = running[0]["InstanceId"]
log = (sae("DescribeInstanceLog", "--InstanceId", iid).get("Data") or "")
m = re.search(r"started: concurrency=(\d+)[^\n]*browser=(\w+)", log) if (re := __import__("re")) else None
print("worker instance:", iid)
print("started:", m.group(0) if m else "not found")
print("needs_login in log:", "needs_login" in log)
print("tail:", log[-400:])
