#!/usr/bin/env python3
"""绑定 geo-profile-3 Context 开新会话并经 CDP 检查 DeepSeek 登录态残留——
验证 Context 是否真的跨会话持久化了浏览器登录态(闸门 #3 实测手段)。""",
import json, subprocess, sys, urllib.parse, urllib.request, uuid, datetime

TOKEN = open('/tmp/ab-token').read().strip()
EP = "https://agentbay.cn-hangzhou.aliyuncs.com"

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

ctx = rpc("GetContext", {"Name": "geo-profile-3", "AllowCreate": "true"})
cid = dig(ctx, "Id", "ContextId")
print("context:", cid)
s = rpc("CreateMcpSession", {"ImageId": "browser_latest", "RegionId": "cn-hangzhou", "Labels": '{"app":"geolens-probe"}'})
sid = dig(s, "SessionId", "sessionId")
print("session:", sid)
b = rpc("BindContexts", {"SessionId": sid, "PersistenceDataList": json.dumps([{"ContextId": cid, "Path": "/home/wuying/workspace"}])})
print("bind:", json.dumps(b, ensure_ascii=False)[:150])
import time
for i in range(6):
    r = rpc("DescribeSessionContexts", {"SessionId": sid})
    if cid in json.dumps(r): print("bound visible at", i); break
    time.sleep(2)
link = rpc("GetCdpLink", {"SessionId": sid})
cl = dig(link, "CdpLink", "Url", "url", "Link")
print("CDP:", cl)
if cl:
    r = subprocess.run(["node", "cdp-probe.js", cl], capture_output=True, text=True, cwd="/Users/yanghuaiyuan/AI/geo/apps/worker-web")
    print(r.stdout); print(r.stderr[:300])
rpc("ReleaseMcpSession", {"SessionId": sid})
print("released")
