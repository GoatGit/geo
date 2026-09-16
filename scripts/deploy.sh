#!/usr/bin/env bash
# GeoLens 一键发布:构建 amd64 镜像 → 推送 ACR → SAE 三应用滚动发布 → 验证变更单。
#
# 用法:
#   scripts/deploy.sh            # 自动取下一个版本号(扫描 ACR 已用最大 vN + 1)
#   scripts/deploy.sh v13        # 指定版本号
#
# 前置:aliyun CLI 已配置(cn-hangzhou AK);docker 已登录 ACR;
#       数据库迁移请先于本脚本执行(pnpm db:migrate 指向生产库)——迁移只加不改,向后兼容。
set -euo pipefail

REGION="cn-hangzhou"
REGISTRY="crpi-fgbi72bokijrd5cd.cn-hangzhou.personal.cr.aliyuncs.com/gemux/geo"
# geo-api 内网 SLB VIP(DescribeApplicationSlbs IntranetIp):Next rewrites 在 build 期固化,
# 不传此构建参数会导致 geo-web 全部 /api 请求 500(容器内 ECONNREFUSED localhost:3000,见 docs/sae 事故复盘)
API_ORIGIN="http://10.115.0.73:3000"
APPS=(
  "geo-api:878a6fb6-c546-4561-8afa-72c84e649a33"
  "geo-worker:ffd157f3-36b3-4e7c-b998-af2fa9049a27"
  "geo-web:b897a60c-a4e7-4b79-b71b-612cf367a69d"
)

TAG="${1:-}"
if [ -z "$TAG" ]; then
  MAX=0
  for t in $(docker images --format '{{.Tag}}' "$REGISTRY" 2>/dev/null); do
    case "$t" in v[0-9]*) n=${t#v}; [ "$n" -gt "$MAX" ] && MAX=$n ;; esac
  done
  TAG="v$((MAX + 1))"
fi
IMAGE="$REGISTRY:$TAG"
echo "== ① 构建 $IMAGE(linux/amd64,无 provenance:ACR 个人版不接受 attestation 清单)=="
git diff --quiet || { echo "工作区有未提交改动,将一并进入镜像(建议先提交)"; }
docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
  --build-arg API_ORIGIN="$API_ORIGIN" -t "$IMAGE" .

echo "== ② 推送 ACR =="
docker push "$IMAGE"

echo "== ③ SAE 三应用滚动发布 =="
ORDERS=()
for entry in "${APPS[@]}"; do
  NAME="${entry%%:*}"; APP_ID="${entry##*:}"
  ORDER=$(aliyun sae DeployApplication --RegionId "$REGION" --AppId "$APP_ID" --ImageUrl "$IMAGE" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['Data']['ChangeOrderId'])")
  echo "  $NAME → 变更单 $ORDER"
  ORDERS+=("$NAME:$ORDER")
done

echo "== ④ 等待变更单(每 30s 轮询,至多 6 分钟)=="
PENDING=${#ORDERS[@]}
for _ in $(seq 1 12); do
  sleep 30
  PENDING=0
  for entry in "${ORDERS[@]}"; do
    NAME="${entry%%:*}"; ID="${entry##*:}"
    ST=$(aliyun sae DescribeChangeOrder --RegionId "$REGION" --ChangeOrderId "$ID" \
      | python3 -c "import json,sys;print(json.load(sys.stdin)['Data']['Status'])")
    case "$ST" in
      2) echo "  $NAME: 成功" ;;
      3) echo "  $NAME: 失败!回滚:aliyun sae DeployApplication --AppId … --ImageUrl $REGISTRY:v$(( ${TAG#v} - 1 ))"; exit 1 ;;
      *) PENDING=$((PENDING + 1)) ;;
    esac
  done
  [ "$PENDING" -eq 0 ] && break
  echo "  …$PENDING 个仍在发布中"
done
[ "$PENDING" -ne 0 ] && { echo "超时:仍有变更单未完成,请到 SAE 控制台确认"; exit 1; }

echo "== ⑤ 终态核验 =="
for entry in "${APPS[@]}"; do
  NAME="${entry%%:*}"; APP_ID="${entry##*:}"
  aliyun sae DescribeApplicationStatus --RegionId "$REGION" --AppId "$APP_ID" \
    | python3 -c "
import json,sys
d=json.load(sys.stdin)['Data']
assert d['CurrentStatus']=='RUNNING' and d['SubStatus']=='NORMAL', d
print(f\"  $NAME: RUNNING/NORMAL, 实例 {d['RunningInstances']}\")"
done
echo "✅ $TAG 已发布至全部应用"
