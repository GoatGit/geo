#!/usr/bin/env python3
"""通过 SLS REST API 创建 Project(华东1杭州)。"""
import base64
import hashlib
import hmac
import json
import urllib.request
from datetime import datetime, timezone

AK = SK = None
cfg = json.load(open("/Users/yanghuaiyuan/.aliyun/config.json"))
cur = cfg.get("current")
for p in cfg.get("profiles", []):
    if p.get("name") == cur:
        AK = p["access_key_id"]
        SK = p["access_key_secret"]
assert AK and SK, "no AK/SK in aliyun profile"

HOST = "cn-hangzhou.log.aliyuncs.com"
PROJECT = "geoprod-logs"


def sls_headers(verb, resource, body=b""):
    date = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")
    ctype = "application/json" if body else ""
    headers = {
        "x-log-apiversion": "0.6.0",
        "x-log-signaturemethod": "hmac-sha1",
        "x-log-bodyrawsize": str(len(body)),
        "Date": date,
    }
    if ctype:
        headers["Content-Type"] = ctype
    canonical = "\n".join([
        verb,
        ctype,
        date,
        f"x-log-apiversion:{headers['x-log-apiversion']}",
        f"x-log-bodyrawsize:{headers['x-log-bodyrawsize']}",
        resource,
    ])
    sig = base64.b64encode(hmac.new(SK.encode(), canonical.encode(), hashlib.sha1).digest()).decode()
    headers["Authorization"] = f"LOG {AK}:{sig}"
    return headers, body


# 创建 Project(PUT /,body 带 projectName)
body = json.dumps({"projectName": PROJECT, "description": "GeoLens SAE logs"}).encode()
headers, _ = sls_headers("PUT", "/", body)
req = urllib.request.Request(f"https://{HOST}/", data=body, headers=headers, method="PUT")
try:
    with urllib.request.urlopen(req) as r:
        print("created:", r.status)
except urllib.error.HTTPError as e:
    print("create:", e.code, e.read().decode()[:200])

# 校验:列出 projects
headers, _ = sls_headers("GET", "/")
req = urllib.request.Request(f"https://{HOST}/", headers=headers, method="GET")
with urllib.request.urlopen(req) as r:
    d = json.loads(r.read())
    names = [p["projectName"] for p in d.get("projects", {}).get("project", [])]
    print("projects:", names)
    print("OK" if PROJECT in names else "NOT FOUND")
