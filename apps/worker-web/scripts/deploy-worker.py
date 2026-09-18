#!/usr/bin/env python3
"""重新部署 geo-worker(拉取当前配置,仅换镜像)。用法: python3 deploy-worker.py <image-tag>"""
import json, subprocess, sys

R = "cn-hangzhou"
APP = "ffd157f3-36b3-4e7c-b998-af2fa9049a27"  # geo-worker
ACR = "crpi-fgbi72bokijrd5cd.cn-hangzhou.personal.cr.aliyuncs.com"
IMAGE = f"{ACR}/gemux/geo:{sys.argv[1] if len(sys.argv) > 1 else 'v39-cite'}"

def sae(api, *extra):
    r = subprocess.run(["aliyun", "sae", api, "--RegionId", R, *extra], capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except Exception:
        return None

d = (sae("DescribeApplicationConfig", "--AppId", APP) or {}).get("Data", {})
envs = d.get("Envs")
if isinstance(envs, str):
    envs = json.loads(envs)
print("image:", IMAGE)
print("current env keys:", [e["name"] for e in envs])

out = sae("DeployApplication", "--AppId", APP, "--ImageUrl", IMAGE, "--Envs", json.dumps(envs, ensure_ascii=False))
res = out if isinstance(out, dict) else {}
print("deploy:", res.get("Success"), res.get("RequestId", res.get("Message", ""))[:80])
