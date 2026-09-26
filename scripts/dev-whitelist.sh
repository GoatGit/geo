#!/usr/bin/env bash
# 本地调试:把当前公网 IP 加入线上 RDS/Redis 白名单(家庭宽带 IP 会变,失效时重跑)
set -euo pipefail
MYIP=$(curl -s --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')
[ -z "$MYIP" ] && { echo "无法获取公网 IP"; exit 1; }
aliyun r-kvstore ModifySecurityIps --RegionId cn-hangzhou --InstanceId r-bp13fae164f9f734 \
  --SecurityIps "10.115.0.0/16,$MYIP" > /dev/null
aliyun rds ModifySecurityIps --RegionId cn-hangzhou --DBInstanceId pgm-bp1162bs35p43g4y \
  --SecurityIps "10.115.0.0/16,$MYIP" > /dev/null
echo "白名单已更新:$MYIP"
