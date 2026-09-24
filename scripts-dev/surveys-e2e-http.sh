#!/usr/bin/env bash
# 超级问卷 HTTP 全链路 e2e(异步 worker 版):本地 LLM 桩 + 真实 API + 真实 worker + 真实 DB,跑完自清理
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cat > /tmp/llm-stub.js <<'STUBEOF'
const http = require("http");
const SURVEY = {
  questions: [
    { id: "q1", type: "single", text: "购买新能源车时您最看重什么?", options: ["价格", "续航", "品牌", "智能座舱"] },
    { id: "q2", type: "single", text: "25万价位最合理的配置取向是?", options: ["长续航基础款", "性能版", "高配智能版", "均衡版"] },
    { id: "q3", type: "single", text: "您更倾向哪种购车方式?", options: ["全款", "贷款", "置换", "暂不购买"] },
    { id: "q4", type: "scale", text: "未来6个月内购买25万新能源SUV的可能性(1-10)" },
    { id: "q5", type: "open", text: "您对新能源SUV还有哪些顾虑?" },
  ],
  segments: [
    { ageBand: "25-34", cityTier: "一线", incomeBand: "20-30万", gender: "男", occupationGroup: "专业技术人员", count: 150 },
    { ageBand: "35-44", cityTier: "新一线", incomeBand: "30-50万", gender: "女", occupationGroup: "企业管理", count: 150 },
  ],
};
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const rb = JSON.parse(body || "{}");
    const sys = rb.messages?.find((m) => m.role === "system")?.content || "";
    let content = "{}";
    if (sys.includes("问卷设计器")) content = JSON.stringify(SURVEY);
    else if (sys.includes("虚拟人物")) {
      const quiz = JSON.parse(rb.messages.find((m) => m.role === "user").content).问卷;
      content = JSON.stringify({
        answers: quiz.map((q) =>
          q.type === "single" ? { questionId: q.id, answer: q.options[0] }
          : q.type === "scale" ? { questionId: q.id, answer: 7 }
          : q.type === "multi" ? { questionId: q.id, answer: [q.options[0]] }
          : { questionId: q.id, answer: "担心的主要是充电便利性和保值率。" }),
      });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
}).listen(3100, () => console.log("stub llm on 3100"));
STUBEOF
node /tmp/llm-stub.js > /tmp/stub.log 2>&1 &
STUB=$!

node "$ROOT/scripts-dev/configure-insight.js" clear-db-row
WORKER_ENV="INSIGHT_AGENT_ENABLED=true
INSIGHT_AGENT_MODE=llm
INSIGHT_AGENT_ENDPOINT=http://127.0.0.1:3100/v1
INSIGHT_AGENT_API_KEY=stub
INSIGHT_AGENT_MODEL=qwen-flash
INSIGHT_AGENT_PROTOCOL=openai"

cd "$ROOT/apps/api"
node --env-file=../../.env --env-file=<(echo "$WORKER_ENV") dist/main.js > /tmp/api-e2e.log 2>&1 &
SRV=$!
cd "$ROOT/apps/worker-web"
node --env-file=../../.env --env-file=<(echo "$WORKER_ENV") dist/main.js > /tmp/worker-e2e.log 2>&1 &
WRK=$!
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:3000/health 2>/dev/null && break; sleep 0.5; done
grep -q "successfully started" /tmp/api-e2e.log && echo "[1] API + worker booted"

CODE=$(curl -s -X POST http://localhost:3000/auth/sms/code -H "content-type: application/json" -d '{"phone":"13900001111"}' | node -p "JSON.parse(require('fs').readFileSync(0)).devCode")
TOKEN=$(curl -s -X POST http://localhost:3000/auth/sms/verify -H "content-type: application/json" -d "{\"phone\":\"13900001111\",\"code\":\"$CODE\"}" | node -p "const j=JSON.parse(require('fs').readFileSync(0));j.accessToken||j.token")
echo "[2] auth ok, token ${#TOKEN} chars"

poll_status() {
  for i in $(seq 1 $(( $3 * 2 ))); do
    ST=$(curl -s http://localhost:3000/surveys/$1 -H "Authorization: Bearer $TOKEN" | node -p "JSON.parse(require('fs').readFileSync(0)).status")
    case "$ST" in "$2") echo "$ST"; return 0;; "failed"|"cancelled") echo "$ST"; return 1;; esac
    sleep 0.5
  done
  echo "timeout(last=$ST)"; return 1
}

SID=$(curl -s -X POST http://localhost:3000/surveys -H "content-type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"title":"e2e新车调研","objective":"测试25万价位新能源SUV的购买意向与主要顾虑"}' | node -p "JSON.parse(require('fs').readFileSync(0)).id")
curl -s -X POST http://localhost:3000/surveys:generate -H "content-type: application/json" -H "Authorization: Bearer $TOKEN" -d "{\"surveyId\":$SID}" > /dev/null
ST=$(poll_status $SID ready_selecting 60) && echo "[3] generate: worker 完成 -> $ST" || { echo "[3] generate 失败: $ST"; tail -5 /tmp/worker-e2e.log; exit 1; }
curl -s http://localhost:3000/surveys/$SID -H "Authorization: Bearer $TOKEN" > /tmp/sv.json
node -p "const j=require('/tmp/sv.json');'    题目 '+j.questions.length+' 道, q1: '+j.questions[0].text"

CODE_POOL=$(curl -s -w "\n%{http_code}" -X POST http://localhost:3000/surveys:pools -H "content-type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"surveyId":'$SID',"segments":[{"ageBand":"25-34","cityTier":"一线","incomeBand":"20-30万","gender":"男","occupationGroup":"专业技术人员","count":3},{"ageBand":"35-44","cityTier":"新一线","incomeBand":"30-50万","gender":"女","occupationGroup":"企业管理","count":3}]}' > /tmp/pool.json.raw)
HTTP_POOL=$(echo "$CODE_POOL" | tail -1); awk 'NR>1' /tmp/pool.json.raw > /tmp/pool.json
echo "    pools HTTP $HTTP_POOL body: $(head -c 150 /tmp/pool.json.raw)"
node -p "const j=require('/tmp/pool.json');'[4] pool: '+(j.poolId ?? j.survey.activePoolId)+' size='+j.size+' status='+j.survey.status"
PID=$(node -p "const j=JSON.parse(require('fs').readFileSync('/tmp/pool.json'));j.poolId ?? j.survey.activePoolId")
RUN409=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/surveys:run -H "content-type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"surveyId":'$SID'}')
echo "[5] 未确认人群运行 -> HTTP $RUN409(期望 409)"
curl -s -X POST http://localhost:3000/surveys:pools:approve -H "content-type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"surveyId":'$SID',"poolId":'$PID',"approved":true}' > /dev/null && echo "[6] approved(用户决策闸门)"

curl -s -X POST http://localhost:3000/surveys:run -H "content-type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"surveyId":'$SID'}' > /dev/null
ST=$(poll_status $SID completed 300) && echo "[7] run: worker 完成 -> $ST" || { echo "[7] run 失败: $ST"; tail -5 /tmp/worker-e2e.log; exit 1; }
curl -s http://localhost:3000/surveys/$SID/report -H "Authorization: Bearer $TOKEN" > /tmp/rep.json
node -p "const j=require('/tmp/rep.json');'[8] 报告:\n  '+j.disclaimer+'\n'+j.questions.map(q=>{const t=q.distribution[0];return '  - '+q.question.text.slice(0,24)+' => '+(t?t.value+' '+Math.round(t.share*100)+'%':(q.responses[0]||'').slice(0,36))}).join('\n')"

kill $SRV $WRK $STUB 2>/dev/null
node "$ROOT/scripts-dev/configure-insight.js" clear-db-row > /dev/null
echo "[9] cleaned up(进程已停, insightAgent DB 行已清)"
