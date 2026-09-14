#!/usr/bin/env python3
"""部署收尾编排:镜像拉取凭据 + 三应用重部署 + SLB 校验。"""
import json
import subprocess
import sys
import time

R = "cn-hangzhou"
NS = "cn-hangzhou:geoprod"
VPC = "vpc-bp1ioagqblkgjyek6nirf"
VS = "vsw-bp1mlk3jt47sa0tc2mdx3"
SG = "sg-bp19b1oh9sjwn9bsagdy"
ACR = "crpi-fgbi72bokijrd5cd.cn-hangzhou.personal.cr.aliyuncs.com/gemux"
IMAGE = f"{ACR}/geo:v1"
API_CLB = "lb-bp1mvgmf93k1v1np5h3v0"
DB_CLB = "lb-bp19o5xbqnxjme8h5nbp1"

APPS = {
    "geo-api": "878a6fb6-c546-4561-8afa-72c84e649a33",
    "geo-worker": "ffd157f3-36b3-4e7c-b998-af2fa9049a27",
    "geo-web": "b897a60c-a4e7-4b79-b71b-612cf367a69d",
}


def run(args, input_text=None):
    r = subprocess.run(args, capture_output=True, text=True, input=input_text)
    return r.stdout + r.stderr


def sae(api, *extra):
    return run(["aliyun", "sae", api, "--RegionId", R, *extra])


def jload(text):
    try:
        return json.loads(text)
    except Exception:
        return None


# 1. ACR 拉取凭据(docker credential helper)
cred = run(["docker-credential-desktop", "get"], input_text="crpi-fgbi72bokijrd5cd.cn-hangzhou.personal.cr.aliyuncs.com")
try:
    cj = json.loads(cred)
    acr_user, acr_pass = cj["Username"], cj["Secret"]
except Exception as e:
    print("FATAL: 无法获取 ACR 凭据", e)
    sys.exit(1)
print("ACR user:", acr_user)

# 2. 命名空间下创建拉取凭据(k8s dockerconfigjson 格式)
import base64

auth = base64.b64encode(f"{acr_user}:{acr_pass}".encode()).decode()
dockerconfig = {"auths": {"crpi-fgbi72bokijrd5cd.cn-hangzhou.personal.cr.aliyuncs.com": {
    "username": acr_user, "password": acr_pass, "auth": auth}}}
secret_data = json.dumps({".dockerconfigjson": json.dumps(dockerconfig)})
out = sae(
    "CreateSecret",
    "--NamespaceId", NS,
    "--SecretName", "geo-acr-pull",
    "--SecretType", "kubernetes.io/dockerconfigjson",
    "--SecretData", secret_data,
)
res = jload(out)
if res and res.get("Success"):
    secret_id = (res.get("Data") or {}).get("SecretId")
    print("secret created:", secret_id)
else:
    # 已存在则取列表里的
    lst = jload(sae("ListSecrets", "--NamespaceId", NS))
    secrets = lst.get("Data") if isinstance(lst.get("Data"), list) else []
    secret_id = next((s.get("SecretId") for s in secrets if s.get("SecretName") == "geo-acr-pull"), None)
    print("secret reuse/fail:", secret_id, str(lst)[:120])
if not secret_id:
    sys.exit("FATAL: secret 不可用")

# 3. 三应用重新部署,挂 ImagePullSecrets
def deploy(app_id, name, command, envs_path):
    envs = open(envs_path).read().strip()
    cmd = json.dumps(command)
    out = sae(
        "DeployApplication",
        "--AppId", app_id,
        "--ImageUrl", IMAGE,
        "--Replicas", "1",
        "--Cpu", "500",
        "--Memory", "1024",
        "--VpcId", VPC,
        "--VSwitchId", VS,
        "--SecurityGroupId", SG,
        "--Command", cmd,
        "--Envs", envs,
        "--ImagePullSecrets", secret_id,
    )
    res = jload(out)
    ok = res and res.get("Success")
    print(f"deploy {name}: {'OK' if ok else out[:180]}")
    return ok


deploy(APPS["geo-db"], "geo-db", ["postgres"], "/tmp/envs-api.json") if False else None
# geo-db 用 postgres 镜像,单独部署
db_secret_deploy = sae(
    "DeployApplication",
    "--AppId", APPS["geo-db"],
    "--ImageUrl", f"{ACR}/geo-postgres:16-alpine",
    "--Replicas", "1",
    "--Cpu", "500",
    "--Memory", "1024",
    "--VpcId", VPC,
    "--VSwitchId", VS,
    "--SecurityGroupId", SG,
    "--Envs", json.dumps([
        {"name": "POSTGRES_USER", "value": "geo"},
        {"name": "POSTGRES_PASSWORD", "value": json.load(open("/tmp/geo-prod-infra.json"))["db_pass"]},
        {"name": "POSTGRES_DB", "value": "geo"},
        {"name": "PGDATA", "value": "/var/lib/postgresql/data/pgdata"},
    ]),
    "--ImagePullSecrets", secret_id,
)
res = jload(db_secret_deploy)
print("deploy geo-db:", "OK" if res and res.get("Success") else db_secret_deploy[:180])

deploy(APPS["geo-api"], "geo-api", ["node", "apps/api/dist/main.js"], "/tmp/envs-api.json")
deploy(APPS["geo-worker"], "geo-worker", ["node", "apps/worker-web/dist/main.js"], "/tmp/envs-worker.json")
deploy(APPS["geo-web"], "geo-web", ["node", "apps/web/node_modules/next/dist/bin/next", "start", "-p", "3001"], "/tmp/envs-web.json")

# 4. 等待稳定
print("waiting for stability...")
for i in range(30):
    time.sleep(10)
    states = []
    for name, app_id in APPS.items():
        d = jload(sae("DescribeApplicationStatus", "--AppId", app_id)) or {}
        data = d.get("Data") or {}
        states.append(f"{name}={data.get('CurrentStatus')}/{data.get('LastChangeOrderRunning')}")
    print(" ", states)
    if all("RUNNING False" in s for s in states):
        break

# 5. SLB 绑定状态复查
for name, app_id in APPS.items():
    d = jload(sae("DescribeApplicationSlbs", "--AppId", app_id)) or {}
    data = d.get("Data") or {}
    print(name, "internet:", data.get("Internet"), "intranet:", data.get("Intranet"))
