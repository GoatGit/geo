#!/usr/bin/env python3
"""切换 geo-worker 的 BROWSER_MODE(mock/agentbay)并重新部署(SAE DeployApplication)。
闸门 #3 不成立时按 docs/07 §13 回退 mock;通过后切回 agentbay。用法: python3 flip-worker-mode.py"""
import json, subprocess
R = "cn-hangzhou"
APP = "ffd157f3-36b3-4e7c-b998-af2fa9049a27"
def sae(api, *extra):
    r = subprocess.run(["aliyun", "sae", api, "--RegionId", R, *extra], capture_output=True, text=True)
    try: return json.loads(r.stdout)
    except Exception: return None

d = (sae("DescribeApplicationConfig", "--AppId", APP) or {}).get("Data", {})
envs = d.get("Envs")
if isinstance(envs, str):
    try: envs = json.loads(envs)
    except Exception: envs = []
envs = [e for e in (envs or []) if e.get("name") != "BROWSER_MODE"]
envs.append({"name": "BROWSER_MODE", "value": "mock"})
# 引擎开关类型 env 可能也存了 login 相关,保持其余原样
out = sae("DeployApplication", "--AppId", APP, "--ImageUrl",
          "crpi-fgbi72bokijrd5cd.cn-hangzhou.personal.cr.aliyuncs.com/gemux/geo:v16",
          "--Envs", json.dumps(envs, ensure_ascii=False))
res = out if isinstance(out, dict) else {}
print("deploy:", res.get("Success"), "| envs:", [e["name"] + "=" + (e["value"] if e["name"] != "DATABASE_URL" else "***") for e in envs if e["name"] in ("BROWSER_MODE", "NODE_ENV", "WORKER_CONCURRENCY")])
