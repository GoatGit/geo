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
# preferred-chain 固定 ISRG Root X1:LE 默认链(YR1/Root YR)是 2026 新根,
# 存量移动设备(尤其安卓)未预置 → TLS 校验失败、移动网络打不开(X1 链全设备兼容)
"$ACME" --issue -d "$DOMAIN" --dns dns_ali --keylength 2048 --preferred-chain "ISRG Root X1" --force || exit 1

# ② 拼服务链:fullchain(leaf + 中间 + 交叉中间),剔除自签根(CLB 不接受根证书)
python3 - "$DOMAIN" <<'EOF'
import re, sys, os, subprocess, tempfile
domain = sys.argv[1]
raw = open(os.path.expanduser(f"~/.acme.sh/{domain}/fullchain.cer")).read()
certs = re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", raw, re.S)
assert len(certs) >= 2, f"expect leaf+intermediate, got {len(certs)}"
out = []
for c in certs:
    f = tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False); f.write(c); f.close()
    sub = subprocess.run(["openssl", "x509", "-in", f.name, "-noout", "-subject", "-issuer"], capture_output=True, text=True).stdout
    if f"subject={sub.split('issuer=')[0]}" in sub and "subject=" in sub and sub.count("subject=") >= 0:
        pass
    # 自签(根)判定:subject == issuer
    subj = sub.split("issuer=")[0].replace("subject=", "").strip()
    issuer = sub.split("issuer=")[1].strip() if "issuer=" in sub else ""
    if subj and issuer and subj != issuer:
        out.append(c)
assert len(out) >= 2, f"no valid chain, {len(out)}"
open("/tmp/geo-renew-chain.pem", "w").write("\n".join(out) + "\n")
print(f"chain: {len(out)} certs (leaf + intermediates)")
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
