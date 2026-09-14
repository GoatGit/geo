#!/usr/bin/env python3
"""直接签名调用 SAE OpenAPI:创建镜像拉取凭据并列出确认。"""
import base64
import datetime
import hashlib
import hmac
import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

ACR_HOST = "crpi-fgbi72bokijrd5cd.cn-hangzhou.personal.cr.aliyuncs.com"
R = "cn-hangzhou"
NS = "cn-hangzhou:geoprod"
ENDPOINT = "sae.cn-hangzhou.aliyuncs.com"

cfg = json.load(open("/Users/yanghuaiyuan/.aliyun/config.json"))
cur = cfg.get("current")
profile = next(p for p in cfg.get("profiles", []) if p.get("name") == cur)
AK = profile["access_key_id"]
SK = profile["access_key_secret"]


def pct(s):
    return urllib.parse.quote(s, safe="-_.~")


def signed(params, method):
    p = {k: (v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)) for k, v in params.items()}
    p["SignatureMethod"] = "HMAC-SHA1"
    p["SignatureNonce"] = str(uuid.uuid4())
    p["AccessKeyId"] = AK
    p["SignatureVersion"] = "1.0"
    p["Timestamp"] = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    canon = "&".join(f"{pct(k)}={pct(v)}" for k, v in sorted(p.items()))
    to_sign = f"{method}&{pct('/')}&{pct(canon)}"
    p["Signature"] = base64.b64encode(hmac.new((SK + "&").encode(), to_sign.encode(), hashlib.sha1).digest()).decode()
    return p


def call(action, params, method="GET"):
    p = signed({"Action": action, **params}, method)
    url = f"https://{ENDPOINT}/?{urllib.parse.urlencode(p)}"
    req = urllib.request.Request(url, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()[:300]}")


cred = subprocess.run(["docker-credential-desktop", "get"], input=ACR_HOST, capture_output=True, text=True)
cj = json.loads(cred.stdout)
user, password = cj["Username"], cj["Secret"]
auth = base64.b64encode(f"{user}:{password}".encode()).decode()
dockerconfig = {"auths": {ACR_HOST: {"username": user, "password": password, "auth": auth}}}

secret_name = "geo-acr-pull"
try:
    res = call("CreateSecret", {
        "NamespaceId": NS,
        "SecretName": secret_name,
        "SecretType": "kubernetes.io/dockerconfigjson",
        "SecretData": {".dockerconfigjson": dockerconfig},
    }, method="POST")
    print("created:", res)
except RuntimeError as e:
    if "already" in str(e):
        print("already exists")
    else:
        print("create failed:", e)
        sys.exit(1)

lst = call("ListSecrets", {"NamespaceId": NS})
data = lst.get("Data")
secrets = data if isinstance(data, list) else (data or {}).get("Secrets", {}).get("Secret", [])
sid = next((s.get("SecretId") for s in secrets if s.get("SecretName") == secret_name), None)
print("SECRET_ID:", sid)
open("/tmp/geo-secret-id.txt", "w").write(sid or "")
if not sid:
    sys.exit(1)
