#!/usr/bin/env python3
"""在 geo-api 容器里直接测试 RDS 认证,找出可用密码。"""
import json
import os
import subprocess
import sys
import time
import urllib.parse

R = "cn-hangzhou"
APIID = "878a6fb6-c546-4561-8afa-72c84e649a33"
ACR = "crpi-fgbi72bokijrd5cd.cn-hangzhou.personal.cr.aliyuncs.com/gemux"
HOST = "pgm-bp1162bs35p43g4y.pg.rds.aliyuncs.com"
DB = "geo"
USER = "geo"

infra = json.load(open("/tmp/geo-prod-infra.json"))
candidates = [
    infra.get("rds_pass", ""),
    os.environ.get("PG_PASS", ""),    # 凭据一律走环境变量,勿写进代码(曾泄漏需轮换)
]

PROBE = (
    "const { Client } = require('pg');"
    "const c = new Client({ connectionString: process.env.DATABASE_URL });"
    "c.connect().then(() => c.query('select 1')).then(r => { console.log('PG_OK', r.rows[0]); process.exit(0); })"
    ".catch(e => { console.log('PG_FAIL', e.code || '', e.message); process.exit(1); });"
)


def sae(api, *extra):
    r = subprocess.run(["aliyun", "sae", api, "--RegionId", R, *extra], capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {}


def deploy_probe(pw):
    url = f"postgres://{USER}:{urllib.parse.quote(pw, safe='')}@{HOST}:5432/{DB}"
    envs = json.dumps([
        {"name": "DATABASE_URL", "value": url},
        {"name": "NODE_ENV", "value": "staging"},
    ])
    d = sae("DeployApplication",
            "--AppId", APIID,
            "--ImageUrl", f"{ACR}/geo:v1",
            "--Replicas", "1", "--Cpu", "500", "--Memory", "1024",
            "--Command", json.dumps(["node", "-e", PROBE]),
            "--Envs", envs)
    return d.get("Success")


def log_tail():
    g = sae("DescribeApplicationGroups", "--AppId", APIID)
    data = g.get("Data")
    gid = data[0]["GroupId"] if isinstance(data, list) and data else ""
    if not gid:
        return ""
    ins = sae("DescribeApplicationInstances", "--AppId", APIID, "--GroupId", gid)
    idata = (ins.get("Data") or {}).get("Instances", [])
    if not idata:
        return ""
    iid = idata[0].get("InstanceId")
    log = sae("DescribeInstanceLog", "--InstanceId", iid)
    return (log.get("Data") or "")


for pw in candidates:
    if not deploy_probe(pw):
        print("deploy failed for candidate; skip")
        continue
    time.sleep(35)
    tail = log_tail()
    print(f"candidate [{pw[:6]}...] → log tail:", tail.replace("\n", " | ")[:220])
    if "PG_OK" in tail:
        print(f"\n✅ 可用密码前缀: {pw[:6]}... — 完整值在 SAE 环境变量 DATABASE_URL 里")
        sys.exit(0)

print("\n❌ 所有候选密码均失败 — RDS 密码与候选不一致,需要重置")
sys.exit(1)
