#!/usr/bin/env python3
"""AgentBay RPC 链路探针:GetContext → CreateMcpSession → BindContexts → Release。
用于验证 AGENTBAY_API_TOKEN 的 Context 权限与绑定是否可用(docs/07 §13 闸门 #3)。
用法: python3 agentbay-probe.py <AGENTBAY_API_TOKEN>""",
import json, subprocess, sys, urllib.parse, urllib.request, uuid, datetime

TOKEN = open('/tmp/ab-token').read().strip() if len(sys.argv) < 2 else sys.argv[1]
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
    data = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(EP, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:400]
        return {"__http": e.code, "__body": body}

# ① GetContext(AllowCreate)
ctx = rpc("GetContext", {"Name": "geo-profile-3", "AllowCreate": "true"})
print("① GetContext:", json.dumps(ctx, ensure_ascii=False)[:260])
cid = None
data = ctx.get("Data") if isinstance(ctx.get("Data"), dict) else {}
for src in (data, ctx):
    for k in ("Id", "ContextId", "contextId"):
        if isinstance(src.get(k), str) and src[k]:
            cid = src[k]; break
    if cid: break
print("contextId:", cid)
if not cid:
    print("无 ContextId,终止"); sys.exit(0)

# ② CreateMcpSession
s = rpc("CreateMcpSession", {"ImageId": "browser_latest", "RegionId": "cn-hangzhou", "Labels": json.dumps({"app": "geolens-probe"})})
print("② CreateMcpSession:", json.dumps(s, ensure_ascii=False)[:260])
sdata = s.get("Data") if isinstance(s.get("Data"), dict) else {}
sid = None
for src in (sdata, s):
    for k in ("SessionId", "sessionId"):
        if isinstance(src.get(k), str) and src[k]:
            sid = src[k]; break
    if sid: break
print("sessionId:", (sid[:20] + '...') if sid else None)
if not sid:
    sys.exit(0)

# ③ BindContexts(关键验证点)
b = rpc("BindContexts", {"SessionId": sid, "PersistenceDataList": json.dumps([{"ContextId": cid, "Path": "/home/wuying/workspace"}])})
print("③ BindContexts:", json.dumps(b, ensure_ascii=False)[:400])

# ④ 清理
r = rpc("ReleaseMcpSession", {"SessionId": sid})
print("④ Release:", json.dumps(r, ensure_ascii=False)[:120])
