import { execFileSync } from 'node:child_process';
const BASE = 'http://localhost:3001';
const phone = '13810497490';
const token = (await import('node:fs')).readFileSync('/tmp/local-admin-token', 'utf8').trim();
const c1 = JSON.parse(execFileSync('curl', ['-s','--max-time','20','-X','POST','-H','content-type: application/json','-d',JSON.stringify({phone}),`${BASE}/api/auth/sms/code`]).toString());
const v = JSON.parse(execFileSync('curl', ['-s','--max-time','20','-X','POST','-H','content-type: application/json','-d',JSON.stringify({phone, code: c1.devCode}),`${BASE}/api/auth/sms/verify`]).toString());
const t = v.accessToken;
if (!t) { console.log('登录失败'); process.exit(1); }
console.log('admin 登录 OK, role:', v.account?.role);
const r = JSON.parse(execFileSync('curl', ['-s','--max-time','20','-X','POST','-H',`Authorization: Bearer ${t}`,`${BASE}/api/admin/accounts/2/login`]).toString());
console.log('登录会话:', r.sessionId);
let last = '';
for (let i = 0; i < 66; i++) {
  await new Promise(res => setTimeout(res, 5000));
  try {
    const st = JSON.parse(execFileSync('curl', ['-s','--max-time','15','-H',`Authorization: Bearer ${t}`,`${BASE}/api/admin/login/${r.sessionId}`]).toString());
    const line = `${st.state} - ${st.detail?.slice(0, 70) ?? ''}`;
    if (line !== last) { console.log(`[${i*5}s]`, line); last = line; }
    if (['done','timeout','error','cancelled'].includes(st.state)) break;
  } catch { /* 忽略轮询错误 */ }
}
