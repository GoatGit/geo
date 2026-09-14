#!/usr/bin/env bash
# 短信一键接线(docs/08 §2):资质就绪后,自动提交签名「青柠GEO」+验证码模板,轮询审核,打印收尾动作。
#
# 前置(控制台一次性动作,OpenAPI 不提供资质创建):
#   阿里云短信控制台 → 国内消息 → 资质管理 → 添加资质(营业执照/身份证照片)
# 用法:
#   scripts/wire-sms.sh                 # 自动轮询等待资质审核通过后提交签名+模板
#   QUALIFICATION_ID=123 scripts/wire-sms.sh   # 资质已审核通过时直接指定
set -euo pipefail

REGION="cn-hangzhou"
SIGN_NAME="${SIGN_NAME:-青柠GEO}"
TEMPLATE_CONTENT="${TEMPLATE_CONTENT:-您的验证码为\${code}，5分钟内有效，请勿泄露。}"
POLL_INTERVAL="${POLL_INTERVAL:-120}"

wait_for_qualification() {
  while true; do
    QID=$(aliyun dysmsapi query-sms-qualification-record --api-version 2017-05-25 --region "$REGION" \
      | python3 -c "
import json,sys
d=json.load(sys.stdin)
quals=(d.get('Data') or {}).get('List') or []
approved=[q for q in quals if str(q.get('QualificationStatus','')) in ('1','AUDIT_PASS','FROZEN_LISTED') or q.get('QualificationReviewStatus')=='审核通过']
print(approved[0].get('QualificationId','') if approved else '')" 2>/dev/null || true)
    if [ -n "$QID" ]; then echo "资质已审核通过, QualificationId=$QID"; echo "$QID"; return 0; fi
    echo "暂无已审核通过的资质,${POLL_INTERVAL}s 后重试(Ctrl-C 退出,资质需在控制台上传材料提交)"
    sleep "$POLL_INTERVAL"
  done
}

QID=${QUALIFICATION_ID:-$(wait_for_qualification | tail -1)}
if [ -z "$QID" ]; then echo "未获得资质 ID,退出"; exit 1; fi

# ① 提交签名(来源 3=网站名;若被驳回可改 SIGN_TYPE/SIGN_SOURCE 重试)
echo "== 提交签名 $SIGN_NAME =="
aliyun dysmsapi create-sms-sign --api-version 2017-05-25 --region "$REGION" \
  --sign-name "$SIGN_NAME" \
  --sign-source 3 \
  --qualification-id "$QID" \
  --remark "青柠GEO:AI 搜索品牌监测平台官网 geo.gemux.cn 的登录验证码短信"

# ② 提交验证码模板
echo "== 提交验证码模板 =="
aliyun dysmsapi create-sms-template --api-version 2017-05-25 --region "$REGION" \
  --template-type 0 \
  --template-name "qingning-verify-code" \
  --template-content "$TEMPLATE_CONTENT" \
  --related-sign-name "$SIGN_NAME" \
  --remark "青柠GEO登录验证码,5分钟有效期"

# ③ 轮询审核结果
echo "== 轮询审核(签名与模板通常 2h 内)=="
while true; do
  SIGN_OK=$(aliyun dysmsapi query-sms-sign-list --api-version 2017-05-25 --region "$REGION" \
    | python3 -c "
import json,sys
d=json.load(sys.stdin)
ss=[s for s in (d.get('SmsSignList') or []) if s.get('SignName')=='$SIGN_NAME']
print(ss[0].get('SignStatus','') if ss else '')" 2>/dev/null || echo "")
  echo "签名状态: $SIGN_OK (0审核中 1通过 2驳回)  ${POLL_INTERVAL}s 后刷新"
  [ "$SIGN_OK" = "1" ] && break
  [ "$SIGN_OK" = "2" ] && echo "签名被驳回,请在控制台查看原因修正后重跑本脚本" && exit 2
  sleep "$POLL_INTERVAL"
done

TPL_CODE=$(aliyun dysmsapi query-sms-template-list --api-version 2017-05-25 --region "$REGION" --page-index 1 --page-size 50 \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
ts=[t for t in (d.get('SmsTemplateList') or []) if t.get('TemplateName')=='qingning-verify-code' and str(t.get('TemplateStatus'))=='1']
print(ts[0].get('TemplateCode','') if ts else '')" 2>/dev/null || echo "")
echo
echo "=============================================="
echo "签名+模板审核通过。收尾(自动或手动改 SAE geo-api):"
echo "  aliyun sae DeployApplication --RegionId $REGION --AppId 878a6fb6-c546-4561-8afa-72c84e649a33 \\"
echo "    --Envs '<原环境变量>' # SMS_PROVIDER=aliyun, NODE_ENV=production, ALIYUN_SMS_TEMPLATE_CODE=$TPL_CODE"
echo "=============================================="
