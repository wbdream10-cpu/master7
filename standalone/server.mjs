import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {identity,sql,withStorage} from './runtime.mjs';
import {digest,secret,passwordValid,hashPassword,verifyPassword,limited,sessionUser,newSession} from './security.mjs';
import * as api from './dist/api.mjs';
import {listConnections,configureConnection,receiveEvent,listEvents} from './connections.mjs';
import {getDepositRequests,createDepositRequest} from './deposit.mjs';
import {createPaymentChannelsHandler} from './payment-channels.mjs';
import {createVPaySettlement,getWallet,getPaymentRecords} from './wallet.mjs';
import {createVPayCheckout} from './vpay-checkout.mjs';
const origin=new URL(process.env.PUBLIC_ORIGIN||'http://127.0.0.1:8080');
if(origin.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(origin.hostname))throw Error('PUBLIC_ORIGIN must use HTTPS outside local development.');
const cookieFlags='; Path=/; HttpOnly; SameSite=Lax'+(origin.protocol==='https:'?'; Secure':'');
const dummyHash=await hashPassword('unknown-account-password-never-used');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function page(title,body,status=200){return new Response(`<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · MASTER7</title><link rel="stylesheet" href="/assets/portal.css"><style>.auth-card{max-width:470px;margin:7vh auto;background:white;border:1px solid #e2eaf6;border-radius:16px;padding:32px}.auth-card h1{font-size:28px}.auth-card form{margin:22px 0}.auth-card label{display:block;font-size:12px;margin:15px 0;color:#62738b}.auth-card input{width:100%;padding:12px;margin-top:8px;border:1px solid #dfe7f2;border-radius:7px;font:inherit}.auth-card p{color:#73839b;font-size:12px;line-height:1.8;margin:15px 0}.auth-links{display:flex;gap:18px;color:#2165e8;font-size:12px;flex-wrap:wrap}.recovery{display:block;padding:16px;background:#edf3ff;border-radius:8px;overflow-wrap:anywhere;user-select:all;font-size:14px}.accounts{max-width:1000px;margin:35px auto;padding:20px}.account-row{background:white;padding:20px;border:1px solid #e2eaf6;border-radius:9px;margin-top:14px}.account-row form{display:inline-block;margin:10px 15px 0 0}@media(max-width:550px){.auth-card{margin:24px 15px;padding:25px}}</style></head><body>${body}</body></html>`,{status,headers:{'content-type':'text/html; charset=utf-8'}})}
function authPage(kind,message='',status=200){const register=kind==='register',reset=kind==='reset';const title=register?'创建平台账号':reset?'找回账号密码':'登录服务平台';return page(title,`<main class="auth-card"><div class="brandmark auth-brand-logo"><img src="/brand/master7-logo.jpg" alt="MASTER7 — SEVEN Premium Experience" width="128" height="128"></div><p class="eyebrow">MASTER7 · SERVICE PORTAL</p><h1>${title}</h1><p>${register?'注册后由老板核实并批准，再登录使用。':reset?'使用注册或开户时保存的恢复码重设密码。':'使用本平台账号与密码进入服务中心。'}</p>${message?'<p role="alert">'+escape(message)+'</p>':''}<form method="post" action="/auth/${register?'register':reset?'reset':'login'}"><label>账号<input name="username" required pattern="[a-zA-Z0-9_-]{3,40}" minlength="3" maxlength="40" autocomplete="username"></label>${register?'<label>联系邮箱<input name="email" required type="email" maxlength="254" autocomplete="email"></label>':''}${reset?'<label>账号恢复码<input name="recovery" required maxlength="100" autocomplete="off"></label>':''}<label>${reset?'新密码':'密码'}<input type="password" name="password" required minlength="12" maxlength="256" autocomplete="${register||reset?'new-password':'current-password'}"></label>${register||reset?'<p>密码至少 12 个字符；不要重复使用其他网站的密码。</p>':''}<button class="primary full">${title}</button></form><nav class="auth-links"><a href="/signin">登录</a><a href="/register">注册</a><a href="/reset">找回密码</a></nav></main>`,status)}
function recoveryPage(code,reset=false){return page('保存账号恢复码',`<main class="auth-card"><h1>${reset?'密码已重设':'注册已提交'}</h1><p>请离线保存以下恢复码。它只显示这一次，持有者可以重设你的密码。不要发送给客服或其他人。</p><code class="recovery">${escape(code)}</code><p>${reset?'旧恢复码和所有旧登录会话已失效。下次请使用此新恢复码。':'账号还需老板核实并批准，恢复码不会再次显示。'}</p><a class="primary" href="/signin">返回登录</a></main>`)}
const redirect=(path,cookie)=>new Response(null,{status:303,headers:{location:path,...(cookie?{'set-cookie':cookie}:{})}});
const json=(data,status=200)=>Response.json(data,{status});
const getPaymentChannels=createPaymentChannelsHandler({
 getMemberTenant:email=>withStorage(async()=>{const member=await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get(email);return member?.tenant_id||null;}),
 tenantExists:id=>withStorage(async()=>Boolean(await sql.prepare('SELECT id FROM brands WHERE id=?').get(id))),
});
const vpaySettlement=createVPaySettlement();
const vpayCheckout=createVPayCheckout({settlement:vpaySettlement});
async function dispatch(req){
 const url=new URL(req.url,origin);
 if(['/api/v1/payments/vpay/config','/api/v1/payments/vpay/orders'].includes(url.pathname)){
  const user=await withStorage(()=>sessionUser(req.headers.cookie));
  if(url.pathname.endsWith('/config'))return req.method==='GET'?vpayCheckout.publicStatus(user):json({error:'Method not allowed'},405);
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  if(!user)return json({error:'请先登录'},401);
  if(req.headers.origin!==origin.origin)return json({error:'请求来源不受信任'},403);
  if(req.headers['x-portal-request']!=='1'||!String(req.headers['content-type']).startsWith('application/json'))return json({error:'请求格式错误'},415);
  let data;try{data=JSON.parse((await bodyOf(req)).toString('utf8'));}catch{return json({error:'请求格式错误'},400);}
  // Supplier network calls must not hold the application's global DB queue.
  return vpayCheckout.submit(user,data);
 }
 if(url.pathname==='/api/v1/payment-callbacks/vpay/payment'){
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  if(!String(req.headers['content-type']).startsWith('application/json'))return json({error:'JSON required'},415);
  return vpaySettlement.receive(await bodyOf(req),req.headers.authorization);
 }
 if(url.pathname==='/api/v1/payment-channels'){
  if(req.method!=='GET')return json({error:'Method not allowed'},405);
  const user=await withStorage(()=>sessionUser(req.headers.cookie));
  return getPaymentChannels(user,url.searchParams.get('tenant'));
 }
 return withStorage(()=>handle(req));
}
async function bodyOf(req){if(req.portalBody)return req.portalBody;let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>16384)throw Error('TOO_LARGE');chunks.push(c)}return Buffer.concat(chunks)}
async function log(user,action){(await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),user.tenantId||'main',user.email,action,new Date().toISOString()))}
async function accountsPage(user){const head=user.role==='owner';const users=(await sql.prepare(`SELECT u.id,u.username,u.email,u.role,u.approved,p.role AS staff_role,COALESCE(p.tenant_id,m.tenant_id,'main') AS tenant_id FROM portal_users u LEFT JOIN portal_staff p ON p.user_id=u.id LEFT JOIN members m ON m.email=u.email ${head?'':"WHERE u.role<>'owner' AND COALESCE(p.tenant_id,m.tenant_id,'main')=?"} ORDER BY u.created_at DESC LIMIT 300`).all(...(head?[]:[user.tenantId])));return page('账号与租户管理',`<main class="accounts"><div class="page-heading"><div><p class="eyebrow">ACCOUNT MANAGEMENT</p><h1>${head?'总部账号与租户管理':'本租户账号管理'}</h1></div><a class="secondary" href="/admin">返回后台</a></div>${head?`<section class="account-row"><h2>创建空白租户</h2><form class="settings-form" method="post" action="/accounts/tenant"><label>租户代码<input name="tenantId" required pattern="[a-z0-9][a-z0-9_-]{2,39}" maxlength="40"></label><button class="primary">创建租户</button><p>仅创建空白工作空间，不导入账号或内容。</p></form></section>`:''}${users.map(u=>`<section class="account-row"><b>${escape(u.username)}</b><p>${escape(u.email)} · ${escape(u.tenant_id)} · ${escape(u.role==='owner'?'总部':u.staff_role==='tenant_owner'?'租户老板':u.staff_role==='employee'?'员工':'客户')} · ${u.approved?'已批准':'等待批准'}</p>${u.role!=='owner'&&(head||!u.staff_role)?`<form method="post" action="/accounts/${u.approved?'suspend':'approve'}"><input type="hidden" name="id" value="${escape(u.id)}"><button class="secondary">${u.approved?'暂停并撤销登录':'批准账号'}</button></form>`:''}${head&&u.role!=='owner'?`<form class="settings-form" method="post" action="/accounts/role"><input type="hidden" name="id" value="${escape(u.id)}"><label>租户代码<input name="tenantId" value="${escape(u.tenant_id)}" required maxlength="60"></label><label>职责<select name="role"><option value="customer" ${!u.staff_role?'selected':''}>客户</option><option value="tenant_owner" ${u.staff_role==='tenant_owner'?'selected':''}>租户老板</option><option value="employee" ${u.staff_role==='employee'?'selected':''}>员工</option></select></label><button class="secondary">保存归属与职责并撤销旧登录</button><p>已明确归属其他租户的账号不能直接转移。</p></form>`:''}</section>`).join('')}</main>`)}
async function connectionsPage(){const rows=(await listConnections()),events=(await listEvents());return page('通用接口管理',`<main class="accounts"><div class="page-heading"><div><p class="eyebrow">OWNER / CONNECTIONS</p><h1>通用接口管理</h1><p>未配置任何外部服务。接收记录不代表业务已处理。</p></div><a class="secondary" href="/admin">返回老板后台</a></div><section class="account-row"><h2>配置接收通道</h2><form class="settings-form" method="post" action="/connections"><label>连接标识<input name="id" required pattern="[a-z0-9][a-z0-9_-]{2,39}" maxlength="40"></label><label>工作空间 ID<input name="tenantId" required value="main" maxlength="60"></label><label>签名密钥的环境变量名<input name="keyEnv" required pattern="PORTAL_HOOK_[A-Z0-9_]{3,60}" maxlength="72" placeholder="PORTAL_HOOK_..." autocomplete="off"></label><p>这里只填写环境变量名称，密钥由部署负责人在服务器设置，至少 32 字节。</p><label><input type="checkbox" name="enabled"> 启用接收</label><button class="primary">保存连接</button></form></section><section class="account-row"><h2>已配置连接</h2>${rows.length?rows.map(c=>`<div class="account-row"><b>${escape(c.id)}</b><p>${escape(c.tenantId)} · ${c.enabled?'已启用':'已停用'} · ${c.configured?'密钥已配置':'缺少密钥'}</p><code>${escape(c.callbackPath)}</code><p>密钥变量：${escape(c.keyEnv)}</p><form method="post" action="/connections"><input type="hidden" name="id" value="${escape(c.id)}"><input type="hidden" name="tenantId" value="${escape(c.tenantId)}"><input type="hidden" name="keyEnv" value="${escape(c.keyEnv)}">${c.enabled?'':'<input type="hidden" name="enabled" value="on">'}<button class="secondary">${c.enabled?'停用连接':'启用连接'}</button></form></div>`).join(''):'<p>暂无连接。</p>'}</section><section class="account-row"><h2>最近收到的事件</h2><p>仅显示事件元数据，原始内容不会在这里公开。事件仍待接手人员编写适配器处理。</p>${events.length?events.map(e=>`<div class="account-row"><b>${escape(e.type)}</b><p>${escape(e.connectionId)} · ${escape(e.tenantId)} · ${escape(e.receivedAt)}</p><code>${escape(e.eventId)}</code><p>已接收 / 未处理</p></div>`).join(''):'<p>暂无事件。</p>'}</section></main>`)}
async function handle(req){const url=new URL(req.url,origin);const user=(await sessionUser(req.headers.cookie));const method=req.method||'GET';
 if(method==='POST'&&!url.pathname.startsWith('/api/v1/hooks/')&&req.headers.origin!==origin.origin)return json({error:'请求来源不受信任'},403);
 if(url.pathname==='/payment-return'){
  if(method!=='GET')return json({error:'Method not allowed'},405);
  if(!user)return redirect('/signin');
  return page('付款结果核验',`<main class="auth-card"><h1>正在核对付款结果</h1><p>付款结果以钱包与充值记录为准。页面跳转不会增加余额；如仍在处理中，请稍后刷新记录。</p><a class="primary" href="/">返回会员中心查看充值记录</a></main>`);
 }
 if(['/api/v1/wallet','/api/v1/payment-records','/api/v1/payment-records/export'].includes(url.pathname)){
  if(method!=='GET')return json({error:'Method not allowed'},405);
  if(url.pathname==='/api/v1/wallet')return getWallet(user,url.searchParams.get('tenant'),url.searchParams.get('environment')||'production');
  return getPaymentRecords(user,url.searchParams,{exportCSV:url.pathname.endsWith('/export')});
 }
 if(url.pathname==='/account'){
  if(!user)return redirect('/signin');
  if(method==='GET')return page('账号安全',`<main class="auth-card"><h1>账号安全</h1><p>当前账号：${escape(user.displayName)}</p><p>修改密码将退出所有旧登录，并更换恢复码。请准备离线保存新的恢复码。</p><form method="post" action="/account"><label>当前密码<input type="password" name="currentPassword" required minlength="12" maxlength="256" autocomplete="current-password"></label><label>新密码<input type="password" name="newPassword" required minlength="12" maxlength="256" autocomplete="new-password"></label><label>确认新密码<input type="password" name="confirmPassword" required minlength="12" maxlength="256" autocomplete="new-password"></label><button class="primary full">修改密码并退出全部登录</button></form><a href="${user.role==='customer'?'/':'/admin'}">返回平台</a></main>`);
  if(method!=='POST')return new Response('Method not allowed',{status:405});
  if(!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded'))return json({error:'请求格式错误'},415);
  if((await limited('account-password:'+user.userId,10)))return json({error:'尝试过于频繁，请稍后再试'},429);
  const f=new URLSearchParams((await bodyOf(req)).toString()),current=f.get('currentPassword')||'',next=f.get('newPassword')||'',confirm=f.get('confirmPassword')||'';
  if(!passwordValid(next)||next!==confirm||next===current)return json({error:'新密码至少 12 个字符，须与确认一致且不同于当前密码'},400);
  const row=(await sql.prepare('SELECT password_hash FROM portal_users WHERE id=?').get(user.userId));
  if(!row||!await verifyPassword(current,row.password_hash))return json({error:'当前密码不正确'},400);
  const newHash=await hashPassword(next),recovery=secret();(await sql.exec('BEGIN IMMEDIATE'));try{
   const r=(await sql.prepare('UPDATE portal_users SET password_hash=?,recovery_hash=? WHERE id=? AND password_hash=?').run(newHash,digest(recovery),user.userId,row.password_hash));
   if(!r.changes)throw Error('Concurrent password change');
   (await sql.prepare('DELETE FROM portal_sessions WHERE user_id=?').run(user.userId));(await log(user,'修改账号密码并撤销全部登录'));(await sql.exec('COMMIT'));
  }catch(e){(await sql.exec('ROLLBACK'));throw e;}
  const response=recoveryPage(recovery,true);response.headers.set('set-cookie','portal_session=; Max-Age=0'+cookieFlags);return response;
 }
 if(url.pathname==='/api/v1/deposit-requests'){
  if(!user)return json({error:'请先登录'},401);
  if(method==='GET')return (await getDepositRequests(user,url.searchParams.get('tenant')));
  if(method!=='POST')return json({error:'Method not allowed'},405);
  if(req.headers['x-portal-request']!=='1'||!String(req.headers['content-type']).startsWith('application/json'))return json({error:'请求格式错误'},415);
  let data;try{data=JSON.parse((await bodyOf(req)).toString());}catch{return json({error:'请求格式错误'},400);}
  return (await createDepositRequest(user,url.searchParams.get('tenant'),data));
 }
 if(url.pathname.startsWith('/api/v1/hooks/')){
  if(method!=='POST')return json({error:'Method not allowed'},405);
  return (await receiveEvent(req,url.pathname.slice('/api/v1/hooks/'.length),await bodyOf(req)));
 }
 if(url.pathname==='/api/v1/me'){
  if(method!=='GET')return json({error:'Method not allowed'},405);
  return user?json({id:user.userId,username:user.displayName,role:user.role}):json({error:'Authentication required'},401);
 }
 if(url.pathname==='/connections'||url.pathname.startsWith('/api/v1/connections')){
  if(!user)return url.pathname==='/connections'?redirect('/signin'):json({error:'Authentication required'},401);
  if(user.role!=='owner')return json({error:'Owner access required'},403);
  if(method==='GET'&&url.pathname==='/api/v1/connections')return json({connections:(await listConnections()),events:(await listEvents())});
  if(method==='POST'&&url.pathname==='/api/v1/connections'){
   if(!String(req.headers['content-type']).startsWith('application/json')||req.headers['x-portal-request']!=='1')return json({error:'Invalid request'},415);
   let data;try{data=JSON.parse((await bodyOf(req)).toString());}catch{return json({error:'Invalid JSON'},400);}
   return data&&typeof data==='object'&&!Array.isArray(data)?(await configureConnection(data,user)):json({error:'Invalid request'},400);
  }
  if(method==='POST'&&url.pathname==='/connections'){
   if(!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded'))return json({error:'Invalid request'},415);
   const f=new URLSearchParams((await bodyOf(req)).toString());const r=(await configureConnection({id:f.get('id'),tenantId:f.get('tenantId'),keyEnv:f.get('keyEnv'),enabled:f.get('enabled')==='on'},user));
   return r.ok?redirect('/connections'):r;
  }
  if(method==='GET'&&url.pathname==='/connections')return (await connectionsPage());
  return json({error:'Not found'},404);
 }
 if(method==='GET'&&url.pathname==='/health'){
  try{await sql.prepare('SELECT 1 AS ready').get();return json({status:'ok',database:'ready',scope:'database_readiness',authentication:'platform-password',externalServices:false,release:process.env.RENDER_GIT_COMMIT||'local'});}
  catch{return json({status:'unavailable',database:'unavailable',scope:'database_readiness',externalServices:false},503);}
 }
 if(method==='GET'&&(url.pathname.startsWith('/assets/')||url.pathname==='/brand/master7-logo.jpg')){const name={'/brand/master7-logo.jpg':['master7-logo.jpg','image/jpeg'],'/assets/client.js':['client.js','text/javascript; charset=utf-8'],'/assets/portal.css':['portal.css','text/css; charset=utf-8']}[url.pathname];return name?new Response(readFileSync(resolve('standalone/dist',name[0])),{headers:{'content-type':name[1]}}):new Response('Not found',{status:404})}
 if(method==='GET'&&['/signin','/register','/reset'].includes(url.pathname))return authPage(url.pathname.slice(1));
 if(method==='POST'&&url.pathname.startsWith('/auth/')){
  if(!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded'))return json({error:'请求格式错误'},415);
  const form=new URLSearchParams((await bodyOf(req)).toString()),action=url.pathname.slice(6),username=(form.get('username')||'').trim().toLowerCase(),password=form.get('password')||'';
  if(action==='logout'){const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('portal_session='))?.slice(15);if(token)(await sql.prepare('DELETE FROM portal_sessions WHERE token_hash=?').run(digest(token)));return redirect('/signin','portal_session=; Max-Age=0'+cookieFlags)}
  const ip=req.socket.remoteAddress||'unknown';if((await limited('auth-ip:'+ip,60))||(await limited(action+':'+username,10)))return authPage(action==='login'?'signin':action,'尝试次数过多，请 15 分钟后再试。',429);
  if(!/^[a-z0-9_-]{3,40}$/.test(username))return authPage(action==='login'?'signin':action,'账号格式无效。',400);
  if(action==='register'){
   const email=(form.get('email')||'').trim().toLowerCase();if(!passwordValid(password)||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return authPage('register','请检查邮箱；密码至少 12 个字符，最多 256 字节。',400);
   const recovery=secret(),hash=await hashPassword(password);try{(await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),username,email,hash,'customer',0,digest(recovery),new Date().toISOString()))}catch{return authPage('register','账号或邮箱不可用，请使用其他资料。',409)}return recoveryPage(recovery);
  }
  const row=(await sql.prepare('SELECT * FROM portal_users WHERE username=?').get(username));
  if(action==='login'){
   const valid=await verifyPassword(password,row?.password_hash||dummyHash);if(!row||!valid||!row.approved)return authPage('signin','账号、密码错误，或账号尚未批准。',401);
   return redirect(row.role==='owner'||(await sql.prepare('SELECT user_id FROM portal_staff WHERE user_id=?').get(row.id))?'/admin':'/','portal_session='+(await newSession(row.id))+'; Max-Age=28800'+cookieFlags);
  }
  if(action==='reset'){
   const code=form.get('recovery')||'';if(!row||code.length>100||digest(code)!==row.recovery_hash||!passwordValid(password))return authPage('reset','账号、恢复码或新密码不正确。',400);
   const recovery=secret(),hash=await hashPassword(password);(await sql.exec('BEGIN IMMEDIATE'));try{const result=(await sql.prepare('UPDATE portal_users SET password_hash=?,recovery_hash=? WHERE id=? AND recovery_hash=?').run(hash,digest(recovery),row.id,digest(code)));if(!result.changes)throw Error('Recovery already used');(await sql.prepare('DELETE FROM portal_sessions WHERE user_id=?').run(row.id));(await sql.exec('COMMIT'))}catch(e){(await sql.exec('ROLLBACK'));throw e;}return recoveryPage(recovery,true);
  }
  return new Response('Not found',{status:404});
 }
 if(url.pathname==='/api/portal'){
  if(!['GET','POST'].includes(method))return json({error:'Method not allowed'},405);
  const data=method==='POST'?await bodyOf(req):undefined;const request=new Request(new URL(url.pathname+url.search,origin),{method,headers:{origin:req.headers.origin||'','content-type':String(req.headers['content-type']||''),'x-portal-request':String(req.headers['x-portal-request']||'')},body:data});
  return identity.run(user,()=>method==='POST'?api.POST(request):api.GET(request));
 }
 if(url.pathname==='/accounts'||url.pathname.startsWith('/accounts/')){
  if(!user)return redirect('/signin');if(!['owner','tenant_owner'].includes(user.role))return new Response('无管理权限',{status:403});
  if(method==='GET'&&url.pathname==='/accounts')return (await accountsPage(user));
  if(method==='POST'&&['/accounts/role','/accounts/tenant'].includes(url.pathname)){
   if(user.role!=='owner')return new Response('仅总部可分配职责',{status:403});
   const f=new URLSearchParams((await bodyOf(req)).toString()),tenantId=f.get('tenantId')||'';
   if(url.pathname==='/accounts/tenant'){
    if(!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(tenantId)||tenantId==='main')return json({error:'租户代码无效'},400);
    if((await sql.prepare('SELECT id FROM brands WHERE id=?').get(tenantId)))return json({error:'租户已存在'},409);
    const now=new Date().toISOString();(await sql.exec('BEGIN IMMEDIATE'));try{(await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run(tenantId,tenantId,now));(await log(user,'创建租户：'+tenantId));(await sql.exec('COMMIT'));}catch(e){(await sql.exec('ROLLBACK'));throw e;}return redirect('/accounts');
   }
   const id=f.get('id')||'',role=f.get('role')||'';
   if(!['tenant_owner','employee','customer'].includes(role))return json({error:'职责无效'},400);
   const target=(await sql.prepare("SELECT id,email FROM portal_users WHERE id=? AND role='customer'").get(id));
   if(!target)return json({error:'账号不存在'},404);
   if(tenantId!=='main'&&!(await sql.prepare('SELECT id FROM brands WHERE id=?').get(tenantId)))return json({error:'租户不存在'},404);
   const membership=(await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get(target.email)),staff=(await sql.prepare('SELECT tenant_id FROM portal_staff WHERE user_id=?').get(id));
   if((membership&&membership.tenant_id!==tenantId)||(staff&&staff.tenant_id!==tenantId))return json({error:'账号已归属其他租户，不能直接转移'},409);
   (await sql.exec('BEGIN IMMEDIATE'));try{
    (await sql.prepare('INSERT INTO members(email,tenant_id,created_at) VALUES (?,?,?) ON CONFLICT(email) DO NOTHING').run(target.email,tenantId,new Date().toISOString()));
    if(role==='customer')(await sql.prepare('DELETE FROM portal_staff WHERE user_id=?').run(id));else (await sql.prepare('INSERT INTO portal_staff VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role').run(id,tenantId,role));
    (await sql.prepare('DELETE FROM portal_sessions WHERE user_id=?').run(id));(await log(user,'分配职责：'+target.email+' / '+tenantId+' / '+role));(await sql.exec('COMMIT'));
   }catch(e){(await sql.exec('ROLLBACK'));throw e;}return redirect('/accounts');
  }
  if(method==='POST'&&['/accounts/approve','/accounts/suspend'].includes(url.pathname)){
   const f=new URLSearchParams((await bodyOf(req)).toString()),id=f.get('id')||'',approve=url.pathname.endsWith('approve');
   const target=(await sql.prepare("SELECT u.id,u.username,p.role AS staff_role,COALESCE(p.tenant_id,m.tenant_id,'main') AS tenant_id FROM portal_users u LEFT JOIN portal_staff p ON p.user_id=u.id LEFT JOIN members m ON m.email=u.email WHERE u.id=? AND u.role='customer'").get(id));if(!target)return new Response('账号不存在',{status:404});
   if(user.role==='tenant_owner'&&(target.tenant_id!==user.tenantId||target.staff_role))return json({error:'仅可管理本租户客户'},403);
   (await sql.exec('BEGIN IMMEDIATE'));try{(await sql.prepare('UPDATE portal_users SET approved=? WHERE id=?').run(approve?1:0,id));(await sql.prepare('DELETE FROM portal_sessions WHERE user_id=?').run(id));(await log(user,(approve?'批准账号：':'暂停账号：')+target.username));(await sql.exec('COMMIT'))}catch(e){(await sql.exec('ROLLBACK'));throw e;}return redirect('/accounts');
  }return new Response('Not found',{status:404});
 }
 if(method==='GET'&&['/','/admin'].includes(url.pathname)){
  if(!user)return redirect('/signin');if(url.pathname==='/admin'&&!['owner','tenant_owner','employee'].includes(user.role))return new Response('无管理权限',{status:403});
  return page('服务中心','<div id="root"></div><script type="module" src="/assets/client.js"></script>');
 }
 return new Response('Not found',{status:404});
}
export const server=createServer(async(req,res)=>{let response;try{if(req.method==='POST')req.portalBody=await bodyOf(req);response=await dispatch(req)}catch(e){console.error('Request failed:',e.message==='TOO_LARGE'?'body too large':'internal error');response=json({error:e.message==='TOO_LARGE'?'请求内容过长':'服务暂时无法处理，请稍后重试。'},e.message==='TOO_LARGE'?413:500)}
 // Native same-origin form POSTs must retain Origin for the strict source check above.
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; connect-src 'self'"};if(origin.protocol==='https:')headers['Strict-Transport-Security']='max-age=31536000';response.headers.forEach((v,k)=>headers[k]=v);res.writeHead(response.status,headers);res.end(Buffer.from(await response.arrayBuffer()));});
server.requestTimeout=30000;server.headersTimeout=15000;
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const port=Number(process.env.PORT||8080);server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log('MASTER7 listening on port '+server.address().port+'; origin '+origin.origin));}
