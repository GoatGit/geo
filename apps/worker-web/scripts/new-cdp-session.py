#!/usr/bin/env python3
"""起一个全新的 AgentBay 浏览器会话(不绑 Context,游客态),打印 CDP 链接。
用法: python3 new-cdp-session.py [label]
"""
import json, subprocess, sys, urllib.parse, urllib.request, uuid, datetime

TOKEN = open('/tmp/ab-token').read().strip()
EP = "https://agentbay.cn-hangzhou.aliyuncs.com"
LABEL = sys.argv[1] if len(sys.argv) > 1 else "geolens-cite-probe"

def rpc(action, fields):
    form = {
        "Action": action, "Version": "2025-05-06", "RegionId": "cn-hangzhou",
        "Format": "JSON",
        "Timestamp": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "SignatureNonce": str(uuid.uuid4()),
        "Authorization": f"Bearer {TOKEN}",
        **fields,
    }
    req = urllib.request.Request(EP, data=urllib.parse.urlencode(form).encode(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"__http": e.code, "__body": e.read().decode()[:300]}

def dig(d, *keys):
    srcs = [d] + ([d["Data"]] if isinstance(d.get("Data"), dict) else [])
    for src in srcs:
        for k in keys:
            if isinstance(src.get(k), str) and src[k]:
                return src[k]
    return None

s = rpc("CreateMcpSession", {"ImageId": "browser_latest", "RegionId": "cn-hangzhou", "Labels": json.dumps({"app": LABEL})})
sid = dig(s, "SessionId", "sessionId")
if not sid:
    print("CREATE_FAIL", json.dumps(s, ensure_ascii=False)[:300]); sys.exit(1)
print("session:", sid)
link = rpc("GetCdpLink", {"SessionId": sid})
cl = dig(link, "CdpLink", "Url", "url", "Link")
print("CDP:", cl or json.dumps(link, ensure_ascii=False)[:300])
