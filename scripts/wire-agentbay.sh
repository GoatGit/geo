#!/usr/bin/env bash
# 远程 CDP 一键接线(docs/08 §4):OAuth 登录 → 创建 geo-prod API Key
# → 切换 SAE geo-worker 到 BROWSER_MODE=agentbay → 触发一轮采集 PoC。
# 用法:scripts/wire-agentbay.sh   (浏览器会弹出阿里云授权页,请在 2 分钟内完成登录)
set -euo pipefail

REGION="cn-hangzhou"
WORKER_APP_ID="ffd157f3-36b3-4e7c-b998-af2fa9049a27"
API_ENDPOINT="https://agentbay.cn-shanghai.aliyuncs.com"
IMAGE_ID="browser_latest"
AB="${AB:-$HOME/.aliyun/agentbay}"

echo "== ① AgentBay OAuth(浏览器弹出,尽快完成授权)=="
"$AB" login

echo "== ② 创建 API Key =="
KEY_OUT=$("$AB" apikey create --name geo-prod 2>&1)
echo "$KEY_OUT"
TOKEN=$(echo "$KEY_OUT" | python3 -c "
import sys, re, json
raw = sys.stdin.read()
m = re.search(r'\b(?:ak-[A-Za-z0-9_-]{16,}|[A-Fa-f0-9-]{32,})\b', raw)
if not m:
    for line in raw.splitlines():
        if 'key' in line.lower() and len(line) > 24:
            m = re.search(r'[A-Za-z0-9_-]{24,}', line.split(':')[-1])
            if m: break
print(m.group(0) if m else '')")
if [ -z "$TOKEN" ]; then
  echo "未能从输出解析 Token,请把上面输出中的 API Key 粘贴后重跑:"
  echo "  AGENTBAY_TOKEN=<key> scripts/wire-agentbay.sh --skip-login"
  exit 2
fi
if [ "${1:-}" = "--skip-login" ]; then TOKEN="${AGENTBAY_TOKEN:?}"; fi
echo "Token 解析成功(${#TOKEN} 字符)"

echo "== ③ 切换 geo-worker → agentbay =="
ENVS=$(aliyun sae DescribeApplicationConfig --RegionId "$REGION" --AppId "$WORKER_APP_ID" \
  | python3 -c "
import json,sys
envs=json.load(sys.stdin).get('Data',{}).get('Envs',[])
names={e['name'] for e in envs}
def upsert(name, value):
    global envs
    if name in names:
        for e in envs:
            if e['name']==name: e['value']=value
    else:
        envs.append({'name':name,'value':value})
upsert('BROWSER_MODE','agentbay')
upsert('AGENTBAY_API_TOKEN','$TOKEN')
upsert('AGENTBAY_API_ENDPOINT','$API_ENDPOINT')
upsert('AGENTBAY_IMAGE_ID','$IMAGE_ID')
print(json.dumps(envs, ensure_ascii=False))")
ORDER=$(aliyun sae DeployApplication --RegionId "$REGION" --AppId "$WORKER_APP_ID" --Envs "$ENVS" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['Data']['ChangeOrderId'])")
echo "变更单 $ORDER 发布中..."
sleep 90
aliyun sae DescribeChangeOrder --RegionId "$REGION" --ChangeOrderId "$ORDER" \
  | python3 -c "import json,sys; d=json.load(sys.stdin).get('Data',{}); print('变更单状态:', d.get('Status'), '(2=成功 3=失败)')"

echo "== ④ PoC:触发一轮采集并观察 =="
PG_HOST="${PG_HOST:-geopub.pg.rds.aliyuncs.com}"; PG_PORT="${PG_PORT:-15432}"
PG_USER="${PG_USER:-geo}"; PG_PASS="${PG_PASS:-}"; PG_DB="${PG_DB:-geo}"
BEFORE=$(PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tAc \
  "select count(*) from query_runs" 2>/dev/null || echo "?")
PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -c \
  "update collection_plans set next_run_at=now() where active" >/dev/null
echo "已触发全部计划,等待 4 分钟后对比 query_runs(Worker 日志见 SLS)..."
sleep 240
AFTER=$(PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tAc \
  "select count(*) from query_runs" 2>/dev/null || echo "?")
echo "query_runs: $BEFORE → $AFTER"
echo "完成。若增量 >0 且 SLS 无 CDP 连接错误,远程采集即已生效。"
