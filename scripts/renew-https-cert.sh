#!/usr/bin/env bash
# geo.gemux.cn HTTPS 证书续期 + CLB 更新(docs/08 §5)。
# 前提:本机 ~/.acme.sh 已完成首次签发(dns_ali 凭据保存在 account.conf)。
# 注意:必须 RSA(--keylength 2048);ECC 证书经典 CLB 不支持。
set -euo pipefail

DOMAIN="geo.gemux.cn"
REGION="cn-hangzhou"
CLB_ID="lb-bp1fzv3byjp3gdnc9q4ym"
LISTENER_PORT=443
ACME="${ACME:-$HOME/.acme.sh/acme.sh}"

# ① 签发/续期(acme.sh 自动跳过未到期的)
"$ACME" --issue -d "$DOMAIN" --dns dns_ali --keylength 2048 --force || exit 1

# ② 拼 leaf + 1 张中间证书(全量 fullchain 带多级链,CLB 上传会报格式错)
python3 - "$DOMAIN" <<'EOF'
import re, sys, os
domain = sys.argv[1]
raw = open(os.path.expanduser(f"~/.acme.sh/{domain}/{domain}.cer")).read()
certs = re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", raw, re.S)
assert len(certs) >= 2, f"expect leaf+intermediate, got {len(certs)}"
open("/tmp/geo-renew-chain.pem", "w").write(certs[0] + "\n" + certs[1] + "\n")
EOF

# ③ 上传并拿到新证书 ID
CERT_NAME="geo-rsa-$(date +%Y%m%d%H%M)"
CERT_ID=$(aliyun slb UploadServerCertificate --RegionId "$REGION" \
  --ServerCertificateName "$CERT_NAME" \
  --ServerCertificate "$(cat /tmp/geo-renew-chain.pem)" \
  --PrivateKey "$(cat ~/.acme.sh/$DOMAIN/$DOMAIN.key)" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['ServerCertificateId'])")
echo "uploaded cert: $CERT_ID"

# ④ 443 监听切换证书
aliyun slb SetLoadBalancerHTTPSListenerAttribute --RegionId "$REGION" \
  --LoadBalancerId "$CLB_ID" --ListenerPort "$LISTENER_PORT" \
  --ServerCertificateId "$CERT_ID" > /dev/null
echo "listener $LISTENER_PORT switched to $CERT_NAME"

# ⑤ 验证
sleep 10
curl -s -o /dev/null -w "https://%{url_effective} -> %{http_code}\n" --max-time 15 "https://$DOMAIN/" || true
