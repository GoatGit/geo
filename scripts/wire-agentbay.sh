#!/usr/bin/env bash
# 远程 CDP 一键接线(docs/08 §4):配置 SAE geo-worker 到 agentbay 模式 → 触发采集 PoC。
#
# 用法:
#   AGENTBAY_TOKEN=akm-xxxx scripts/wire-agentbay.sh
# 密钥来源:AgentBay 控制台(无影 AI)→ API Key → 创建/查看,复制完整 akm- 值。
# 注意:ak- 开头的是 KeyId,不能用于会话鉴权;必须是 akm- 开头的完整密钥。
set -euo pipefail

REGION="cn-hangzhou"
WORKER_APP_ID="ffd157f3-36b3-4e7c-b998-af2fa9049a27"
API_ENDPOINT="https://agentbay.cn-shanghai.aliyuncs.com"
IMAGE_ID="browser_latest"
TOKEN="${AGENTBAY_TOKEN:?请设置 AGENTBAY_TOKEN(akm- 开头)}"

echo "== ① 本地验证密钥(创建测试会话)=="
node --input-type=module - "$TOKEN" <<'EOF'
const token = process.argv[2];
const form = new URLSearchParams({
  Action: 'CreateMcpSession', Version: '2025-05-06', RegionId: 'cn-shanghai', Format: 'JSON',
  Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  SignatureNonce: crypto.randomUUID(),
  Authorization: `Bearer ${token}`, ImageId: 'browser_latest',
});
const res = await fetch('https://agentbay.cn-shanghai.aliyuncs.com/', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
});
const text = await res.text();
try {
  const j = JSON.parse(text);
  const sid = j.Data?.SessionId ?? j.Data?.sessionId;
  if (!sid) { console.error('密钥验证失败:', text.slice(0, 300)); process.exit(1); }
  console.log('密钥有效,测试会话:', sid);
  const del = new URLSearchParams({ Action: 'ReleaseMcpSession', Version: '2025-05-06', RegionId: 'cn-shanghai', Format: 'JSON',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), SignatureNonce: crypto.randomUUID(),
    Authorization: `Bearer ${token}`, SessionId: sid });
  await fetch('https://agentbay.cn-shanghai.aliyuncs.com/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: del.toString() });
  console.log('测试会话已释放');
} catch { console.error('非 JSON 响应:', text.slice(0, 200)); process.exit(1); }
EOF

echo "== ② 切换 SAE geo-worker → agentbay =="
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
echo "变更单 $ORDER 发布中(约 90s)..."
sleep 90
aliyun sae DescribeChangeOrder --RegionId "$REGION" --ChangeOrderId "$ORDER" \
  | python3 -c "import json,sys; d=json.load(sys.stdin).get('Data',{}); print('变更单状态:', d.get('Status'), '(2=成功 3=失败)')"

echo "== ③ PoC:触发一轮采集并对比落库 =="
PG_HOST="${PG_HOST:-geopub.pg.rds.aliyuncs.com}"; PG_PORT="${PG_PORT:-15432}"
PG_USER="${PG_USER:?请设置 PG_USER}"; PG_PASS="${PG_PASS:?请设置 PG_PASS(勿写进代码,已泄漏需轮换)}"; PG_DB="${PG_DB:-geo}"
BEFORE=$(PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tAc \
  "select count(*) from query_runs" 2>/dev/null || echo "?")
PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -c \
  "update collection_plans set next_run_at=now() where active" >/dev/null
echo "已触发全部计划,等待 4 分钟..."
sleep 240
AFTER=$(PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tAc \
  "select count(*) from query_runs" 2>/dev/null || echo "?")
echo "query_runs: $BEFORE → $AFTER"
echo "完成。增量 >0 且 SLS 无 CDP 连接错误 = 远程采集生效。"
