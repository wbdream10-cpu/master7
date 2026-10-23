import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
process.env.PORTAL_HOOK_TEST='test-only-signing-key-with-at-least-32-bytes';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
delete process.env.PORTAL_POSTGRES_URL;delete process.env.RENDER;process.env.NODE_ENV='test';
const postgresTest=process.argv.includes('--postgres');
if(postgresTest)process.env.PORTAL_TEST_POSTGRES='1';else delete process.env.PORTAL_TEST_POSTGRES;
const dir=mkdtempSync(join(tmpdir(),'portal-test-'));process.env.PORTAL_DATABASE=join(dir,'portal.sqlite');process.env.PUBLIC_ORIGIN='http://127.0.0.1:8080';
if(postgresTest)process.env.PORTAL_TEST_POSTGRES_PATH=join(dir,'pgdata');
const password='Test-only-password-7823';let ownerRecovery='';
const nativeFetch=globalThis.fetch;let gatewayStatusReads=0;
globalThis.fetch=(input,options)=>input==='https://master7-integration-gateway.onrender.com/providers/vpay/status'?(gatewayStatusReads++,Promise.resolve(Response.json({provider:'vpay',version:'1.7.0',mode:'uat',configured:true,readiness:{channels:{payment:{configurationReady:false,liveReady:false}}}}))):nativeFetch(input,options);
await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['standalone/admin.mjs','create-owner','owner','owner@example.test'],{env:process.env,stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('close',code=>{if(code)return reject(Error(err));ownerRecovery=out.trim().split('\n').at(-1);resolve()});child.stdin.end(password+'\n')});
const {server}=await import('./server.mjs');await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const req=(path,opt={})=>fetch(base+path,{redirect:'manual',...opt});
const form=(path,data,cookie='',origin=process.env.PUBLIC_ORIGIN)=>req(path,{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded',cookie},body:new URLSearchParams(data)});
const post=(data,cookie='',tenant='')=>req('/api/portal'+(tenant?'?tenant='+tenant:''),{method:'POST',headers:{origin:process.env.PUBLIC_ORIGIN,'content-type':'application/json','x-portal-request':'1',cookie},body:JSON.stringify(data)});
const get=(cookie='',tenant='')=>req('/api/portal'+(tenant?'?tenant='+tenant:''),{headers:{cookie}});
const paymentChannels=(cookie='',tenant='')=>req('/api/v1/payment-channels'+(tenant?'?tenant='+tenant:''),{headers:{cookie}});
const session=r=>r.headers.get('set-cookie').split(';')[0];
try{
 assert.equal((await req('/')).status,303);assert.equal((await req('/admin')).status,303);assert.equal((await get()).status,401);assert.equal((await req('/health')).status,200);
 assert.equal((await paymentChannels()).status,401);assert.equal(gatewayStatusReads,0);
 assert.equal((await req('/api/v1/payment-channels',{method:'POST'})).status,405);
 for(const path of ['/api/v1/wallet','/api/v1/payment-records','/api/v1/payment-records/export'])assert.equal((await req(path)).status,401);
 assert.equal((await req('/api/v1/payment-callbacks/vpay/payment')).status,405);
 assert.equal((await req('/api/v1/payment-callbacks/vpay/payment',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,503);
 const health=await (await req('/health')).json();assert.equal(health.database,'ready');assert.equal(health.scope,'database_readiness');assert.equal(health.externalServices,false);
 assert.equal((await req('/signin')).headers.get('referrer-policy'),'same-origin');
 assert((await (await req('/signin')).text()).includes('src="/brand/master7-logo.jpg"'));
 const logoAsset=await req('/brand/master7-logo.jpg');assert.equal(logoAsset.status,200);assert.equal(logoAsset.headers.get('content-type'),'image/jpeg');assert.deepEqual(Buffer.from(await logoAsset.arrayBuffer()),readFileSync('public/brand/master7-logo.jpg'));
 assert.equal((await form('/auth/login',{username:'owner',password},'','https://evil.test')).status,403);
 assert.equal((await form('/auth/login',{username:'owner',password},'','null')).status,403);
 assert.equal((await req('/auth/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'owner',password})})).status,403);
 assert.equal((await form('/auth/register',{username:'alice',email:'alice@example.test',password:'weak'})).status,400);
 let r=await form('/auth/register',{username:'alice',email:'alice@example.test',password});assert.equal(r.status,200);let aliceRecovery=(await r.text()).match(/<code class="recovery">([^<]+)/)[1];
 assert.equal((await form('/auth/login',{username:'alice',password})).status,401);
 r=await form('/auth/login',{username:'owner',password});assert.equal(r.status,303);const ownerCookie=session(r);assert(r.headers.get('set-cookie').includes('HttpOnly'));assert(r.headers.get('set-cookie').includes('SameSite=Lax'));
 const initial=await (await get(ownerCookie)).json();assert.equal(initial.brand.name,'MASTER7');assert.equal(initial.notices.length,0);assert.equal(initial.tickets.length,0);assert.equal(initial.audit.length,0);assert.equal(initial.members.length,0);
 const channelStatus=await (await paymentChannels(ownerCookie)).json();assert.equal(channelStatus.tenantId,'main');assert.equal(channelStatus.channels.length,3);assert(channelStatus.channels.every(channel=>channel.enabled===false));assert.equal(channelStatus.fundsProcessed,false);assert.equal(channelStatus.diagnostics.gateway.mode,'uat');assert.equal(channelStatus.diagnostics.gateway.configured,true);assert.equal(channelStatus.diagnostics.gateway.liveReady,false);assert(gatewayStatusReads>0);
 assert.equal((await post({action:'save-logo',logo:'http://invalid.test/logo.png'},ownerCookie)).status,400);
 assert.equal((await post({action:'save-logo',logo:'https://example.test/logo.png',name:'Must stay unchanged',color:'#000000'},ownerCookie)).status,200);
 const branded=await (await get(ownerCookie)).json();assert.equal(branded.brand.logo,'https://example.test/logo.png');assert.equal(branded.brand.name,initial.brand.name);assert.equal(branded.brand.color,initial.brand.color);
 const brandSettings={name:'MASTER7 Member Services',tagline:'Your member service space',color:'#123AbC',logo:'https://example.test/brand.png',language:'en',supportUrl:'https://support.example.test/help'};
 const brandFields=brand=>Object.fromEntries(Object.keys(brandSettings).map(key=>[key,brand[key]]));
 assert.equal((await post({action:'save-brand',...brandSettings,id:'forged',tenantId:'forged',createdAt:'forged'},ownerCookie)).status,200);
 const savedBrand=await (await get(ownerCookie)).json();assert.deepEqual(brandFields(savedBrand.brand),brandSettings);assert.equal(savedBrand.brand.id,'main');assert.notEqual(savedBrand.brand.createdAt,'forged');
 assert.equal(savedBrand.audit.filter(row=>row.action==='更新品牌设置').length,1);
 for(const change of [{name:''},{name:'x'.repeat(61)},{color:'red;display:none'},{language:'unknown'},{language:null},{supportUrl:'http://support.example.test'},{supportUrl:'javascript:alert(1)'},{supportUrl:'https://user:password@example.test'},{supportUrl:'https://example.test/'+'x'.repeat(1000)},{logo:'https://user:password@example.test/logo.png'}]){
  assert.equal((await post({action:'save-brand',...brandSettings,...change},ownerCookie)).status,400);
 }
 const rejectedBrand=await (await get(ownerCookie)).json();assert.deepEqual(brandFields(rejectedBrand.brand),brandSettings);assert.equal(rejectedBrand.audit.length,savedBrand.audit.length);
 const {language:omittedLanguage,supportUrl:omittedSupport,...legacyBrand}=brandSettings;
 assert.equal((await post({action:'save-brand',...legacyBrand},ownerCookie)).status,200);
 assert.deepEqual(brandFields((await (await get(ownerCookie)).json()).brand),brandSettings);
 assert.equal((await post({action:'save-logo',logo:brandSettings.logo,language:'ms',supportUrl:'https://forged.example.test'},ownerCookie)).status,200);
 assert.deepEqual(brandFields((await (await get(ownerCookie)).json()).brand),brandSettings);
 const {sql,withStorage}=await import('./runtime.mjs');
 await assert.rejects(withStorage(async()=>{await sql.exec('BEGIN IMMEDIATE');await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run('rollback-check','Must not persist',new Date().toISOString());throw Error('Force rollback');}));
 assert.equal(await sql.prepare('SELECT id FROM brands WHERE id=?').get('rollback-check'),undefined);
 const alice=(await sql.prepare("SELECT * FROM portal_users WHERE username='alice'").get());assert.notEqual(alice.password_hash,password);assert.notEqual(alice.recovery_hash,aliceRecovery);
 assert.equal((await form('/accounts/approve',{id:alice.id},ownerCookie)).status,303);
 r=await form('/auth/login',{username:'alice',password});assert.equal(r.status,303);let aliceCookie=session(r);
 const memberChannels=await (await paymentChannels(aliceCookie)).json();assert.equal(memberChannels.diagnostics,undefined);assert(memberChannels.channels.every(channel=>channel.status==='not_open'&&channel.enabled===false));assert.equal(memberChannels.fundsProcessed,false);
 assert.deepEqual(brandFields((await (await get(aliceCookie)).json()).brand),brandSettings);
 const depositPost=(cookie,data,tenant='')=>req('/api/v1/deposit-requests'+(tenant?'?tenant='+tenant:''),{method:'POST',headers:{origin:process.env.PUBLIC_ORIGIN,'content-type':'application/json','x-portal-request':'1',cookie},body:JSON.stringify(data)});
 const depositGet=(cookie,tenant='')=>req('/api/v1/deposit-requests'+(tenant?'?tenant='+tenant:''),{headers:{cookie}});
 const depositPayload={amount:'12.34',currency:'MYR',requestKey:'request_key_test_0001'};
 assert.equal((await depositGet('')).status,401);assert.equal((await depositPost('',depositPayload)).status,401);
 assert.equal((await (await depositGet(aliceCookie)).json()).requests.length,0);
 for(const amount of ['0','-1','1e3','1.001','100000.01','NaN',' 1.00','01.00',1.5])assert.equal((await depositPost(aliceCookie,{...depositPayload,amount})).status,400);
 assert.equal((await depositPost(aliceCookie,{...depositPayload,currency:'USD'})).status,400);
 let submitted=await depositPost(aliceCookie,{...depositPayload,userId:'forged',tenantId:'forged',status:'paid'});assert.equal(submitted.status,201);const depositResult=await submitted.json();assert.equal(depositResult.request.amountMinor,1234);assert.equal(depositResult.request.tenantId,'main');assert.equal(depositResult.request.status,'awaiting_connection');assert.equal(depositResult.fundsProcessed,false);
 submitted=await depositPost(aliceCookie,depositPayload);assert.equal(submitted.status,200);assert.equal((await submitted.json()).duplicate,true);
 assert.equal((await depositPost(aliceCookie,{...depositPayload,amount:'13.34'})).status,409);
 assert.equal((await (await depositGet(ownerCookie)).json()).requests.length,1);
 assert.equal((await sql.prepare('SELECT count(*) AS n FROM portal_deposit_requests').get()).n,1);
 assert.equal((await req('/api/v1/deposit-requests',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json','x-portal-request':'1',cookie:aliceCookie},body:JSON.stringify(depositPayload)})).status,403);
 assert.equal((await req('/admin',{headers:{cookie:aliceCookie}})).status,403);assert.equal((await req('/accounts',{headers:{cookie:aliceCookie}})).status,403);
 assert.equal((await post({action:'save-brand',name:'Bad',tagline:'Bad',color:'#123456',logo:''},aliceCookie)).status,403);
 assert.equal((await post({action:'create-ticket',subject:'Account help',body:'Please reply'},aliceCookie)).status,201);
 const own=await (await get(aliceCookie)).json();assert.equal(own.tickets.length,1);const ticketId=own.tickets[0].id;
 assert.equal((await post({action:'update-ticket',id:ticketId,status:'已完成',reply:'Handled'},ownerCookie)).status,200);
 assert.equal((await (await get(aliceCookie)).json()).tickets[0].reply,'Handled');
 r=await post({action:'create-brand',name:'Independent B'},ownerCookie);assert.equal(r.status,200);const tenant=(await r.json()).tenantId;
 assert.equal((await post({action:'assign-member',email:'alice@example.test'},ownerCookie,tenant)).status,200);
 assert.equal((await get(aliceCookie)).status,401);r=await form('/auth/login',{username:'alice',password});assert.equal(r.status,303);aliceCookie=session(r);
 assert.equal((await (await get(aliceCookie,'main')).json()).tenantId,tenant);assert.equal((await (await get(aliceCookie)).json()).tickets.length,0);
 assert.equal((await post({action:'update-ticket',id:ticketId,status:'已完成',reply:'Cross brand'},ownerCookie,tenant)).status,404);
 assert.equal((await form('/auth/reset',{username:'alice',recovery:'wrong',password:'New-test-password-9834'})).status,400);
 r=await form('/auth/reset',{username:'alice',recovery:aliceRecovery,password:'New-test-password-9834'});assert.equal(r.status,200);const rotated=(await r.text()).match(/<code class="recovery">([^<]+)/)[1];assert.notEqual(rotated,aliceRecovery);
 assert.equal((await get(aliceCookie)).status,401);
 assert.equal((await form('/auth/reset',{username:'alice',recovery:aliceRecovery,password:'Other-password-4390'})).status,400);
 assert.equal((await form('/auth/login',{username:'alice',password})).status,401);
 r=await form('/auth/login',{username:'alice',password:'New-test-password-9834'});assert.equal(r.status,303);const newAlice=session(r);
 assert.equal((await form('/auth/logout',{},newAlice)).status,303);assert.equal((await get(newAlice)).status,401);
 r=await form('/auth/login',{username:'alice',password:'New-test-password-9834'});const approvedCookie=session(r);assert.equal((await form('/accounts/suspend',{id:alice.id},ownerCookie)).status,303);assert.equal((await get(approvedCookie)).status,401);
 const home=await req('/admin',{headers:{cookie:ownerCookie}});const html=await home.text();assert.equal(home.status,200);assert(html.includes('/assets/client.js'));assert(!html.includes('signin-with-chatgpt'));assert(home.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
 const conf={id:'test-hook',tenantId:'main',keyEnv:'PORTAL_HOOK_TEST',enabled:true};
 const connectionPost=(data,cookie=ownerCookie)=>req('/api/v1/connections',{method:'POST',headers:{origin:process.env.PUBLIC_ORIGIN,'content-type':'application/json','x-portal-request':'1',cookie},body:JSON.stringify(data)});
 assert.equal((await req('/api/v1/connections')).status,401);
 assert.equal((await connectionPost(conf,aliceCookie)).status,401);
 assert.equal((await connectionPost({...conf,tenantId:'missing'})).status,404);
 const before=await (await req('/api/v1/connections',{headers:{cookie:ownerCookie}})).json();assert.deepEqual(before,{connections:[],events:[]});
 assert.equal((await connectionPost(conf)).status,200);
 const meta=await (await req('/api/v1/connections',{headers:{cookie:ownerCookie}})).json();assert.equal(meta.connections[0].configured,true);assert(!JSON.stringify(meta).includes(process.env.PORTAL_HOOK_TEST));
 const raw=JSON.stringify({type:'service.updated',data:{reference:'test-reference'}}),stamp=String(Math.floor(Date.now()/1000));
 const hook=(eventId='event-1',body=raw,timestamp=stamp,signature)=>req('/api/v1/hooks/test-hook',{method:'POST',headers:{'content-type':'application/json','x-portal-timestamp':timestamp,'x-portal-event-id':eventId,'x-portal-signature':signature||'sha256='+createHmac('sha256',process.env.PORTAL_HOOK_TEST).update(timestamp+'.'+eventId+'.'+body).digest('hex')},body});
 assert.equal((await hook('event-1',raw,stamp,'sha256='+'0'.repeat(64))).status,401);
 assert.equal((await hook('old-event',raw,'1000000000')).status,401);
 let eventResponse=await hook();assert.equal(eventResponse.status,202);assert.equal((await eventResponse.json()).processed,false);
 eventResponse=await hook();assert.equal(eventResponse.status,202);assert.equal((await eventResponse.json()).duplicate,true);
 assert.equal((await hook('event-1',JSON.stringify({type:'service.updated',data:{reference:'changed'}}))).status,409);
 assert.equal((await sql.prepare('SELECT count(*) AS n FROM portal_events').get()).n,1);
 assert.equal((await connectionPost({...conf,enabled:false})).status,200);assert.equal((await hook('event-2')).status,503);
 assert.equal((await req('/connections',{headers:{cookie:ownerCookie}})).status,200);
 const assets=await req('/assets/client.js');assert.equal(assets.status,200);
 for(let i=0;i<10;i++)assert.equal((await form('/auth/login',{username:'missing',password})).status,401);
 assert.equal((await form('/auth/login',{username:'missing',password})).status,429);
 assert.equal((await form('/accounts/approve',{id:alice.id},ownerCookie,'https://evil.test')).status,403);
 if(!postgresTest){ (await sql.prepare('VACUUM INTO ?').run(join(dir,'snapshot.sqlite')));
 const {DatabaseSync}=await import('node:sqlite');const snapshot=new DatabaseSync(join(dir,'snapshot.sqlite'));assert.equal(snapshot.prepare('SELECT count(*) AS n FROM tickets').get().n,1);snapshot.close();
 const reopened=new DatabaseSync(process.env.PORTAL_DATABASE);assert.equal(reopened.prepare('SELECT count(*) AS n FROM tickets').get().n,1);reopened.close();}
 assert.equal((await form('/accounts/tenant',{tenantId:'alpha'},ownerCookie)).status,303);
 assert.equal((await form('/accounts/tenant',{tenantId:'beta'},ownerCookie)).status,303);
 const ids={};
 for(const username of ['tenantboss','staffmember','tenantclient','outsideclient','insertclient']){
  assert.equal((await form('/auth/register',{username,email:username+'@example.test',password})).status,200);
  ids[username]=(await sql.prepare('SELECT id FROM portal_users WHERE username=?').get(username)).id;
  assert.equal((await form('/accounts/approve',{id:ids[username]},ownerCookie)).status,303);
 }
 for(const [name,role] of [['tenantboss','tenant_owner'],['staffmember','employee'],['tenantclient','customer']])assert.equal((await form('/accounts/role',{id:ids[name],tenantId:'alpha',role},ownerCookie)).status,303);
 await sql.prepare('INSERT INTO portal_finance_staff(user_id,tenant_id,granted_by,granted_at) VALUES (?,?,?,?)').run(ids.staffmember,'alpha',(await sql.prepare("SELECT id FROM portal_users WHERE role='owner'").get()).id,new Date().toISOString());
 let bossLogin=await form('/auth/login',{username:'tenantboss',password});assert.equal(bossLogin.headers.get('location'),'/admin');const tenantBossCookie=session(bossLogin);
 const staffCookie=session(await form('/auth/login',{username:'staffmember',password}));
 const tenantClientCookie=session(await form('/auth/login',{username:'tenantclient',password}));
 assert.equal((await req('/admin',{headers:{cookie:tenantBossCookie}})).status,200);
 assert.equal((await req('/admin',{headers:{cookie:staffCookie}})).status,200);
 assert.equal((await (await depositGet(tenantClientCookie)).json()).requests.length,0);
 assert.equal((await depositPost(tenantClientCookie,{...depositPayload,amount:'44.44'})).status,201);
 assert.equal((await (await depositGet(tenantBossCookie)).json()).requests[0].amountMinor,4444);
 assert.equal((await depositGet(tenantBossCookie,'main')).status,403);
 assert.equal((await depositGet(tenantClientCookie,'main')).status,403);
 assert.equal((await depositGet(staffCookie)).status,403);assert.equal((await depositPost(staffCookie,depositPayload)).status,403);
 assert.equal((await (await depositGet(ownerCookie,'alpha')).json()).requests.length,1);
 const scoped=await (await get(tenantBossCookie)).json();assert.equal(scoped.tenantId,'alpha');assert.equal(scoped.user.role,'tenant_owner');assert.equal(scoped.tenants.length,0);
 assert.equal((await paymentChannels(staffCookie)).status,403);assert.equal((await paymentChannels(tenantBossCookie,'beta')).status,403);assert.equal((await paymentChannels(tenantClientCookie,'beta')).status,403);assert.equal((await paymentChannels(ownerCookie,'missing')).status,404);
 const tenantChannels=await (await paymentChannels(tenantBossCookie)).json();assert.equal(tenantChannels.tenantId,'alpha');assert.equal(tenantChannels.diagnostics,undefined);assert(tenantChannels.channels.every(channel=>channel.enabled===false));
 assert.equal((await get(tenantBossCookie,'beta')).status,403);assert.equal((await get(staffCookie,'beta')).status,403);
 assert.equal((await post({action:'save-notice',title:'No',body:'No',published:true},tenantBossCookie,'beta')).status,403);
 assert.equal((await post({action:'create-brand',name:'No'},tenantBossCookie)).status,403);
 assert.equal((await post({action:'save-logo',logo:'https://example.test/alpha.png'},tenantBossCookie)).status,200);
 const alphaBrand={...brandSettings,name:'Alpha Services',tagline:'Alpha member support',language:'ms',supportUrl:'https://alpha.example.test/support'};
 assert.equal((await post({action:'save-brand',...alphaBrand},tenantBossCookie)).status,200);
 assert.deepEqual(brandFields((await (await get(tenantClientCookie)).json()).brand),alphaBrand);
 for(const [cookie,tenant] of [[tenantBossCookie,'beta'],[staffCookie,''],[tenantClientCookie,'']])assert.equal((await post({action:'save-brand',...alphaBrand,name:'Unauthorized'},cookie,tenant)).status,403);
 assert.deepEqual(brandFields((await (await get(tenantClientCookie)).json()).brand),alphaBrand);
 assert.deepEqual(brandFields((await (await get(ownerCookie)).json()).brand),brandSettings);
 assert.equal((await (await get(tenantBossCookie)).json()).audit.filter(row=>row.action==='更新品牌设置'&&row.actor==='tenantboss@example.test').length,1);
 assert.equal((await post({action:'save-notice',title:'Alpha message',body:'Only alpha',published:true},tenantBossCookie)).status,200);
 assert.equal((await post({action:'save-notice',title:'No',body:'No'},staffCookie)).status,403);
 const workerData=await (await get(staffCookie)).json();assert.equal(workerData.audit.length,0);assert.equal(workerData.members.length,0);
 assert.equal((await req('/accounts',{headers:{cookie:staffCookie}})).status,403);
 assert.equal((await req('/api/v1/connections',{headers:{cookie:tenantBossCookie}})).status,403);
 assert.equal((await req('/api/v1/connections',{headers:{cookie:staffCookie}})).status,403);
 assert.equal((await form('/accounts/approve',{id:ids.outsideclient},tenantBossCookie)).status,403);
 assert.equal((await form('/accounts/suspend',{id:ids.staffmember},tenantBossCookie)).status,403);
 assert.equal((await form('/accounts/tenant',{tenantId:'noaccess'},tenantBossCookie)).status,403);
 assert.equal((await form('/accounts/role',{id:ids.tenantclient,tenantId:'beta',role:'employee'},ownerCookie)).status,409);
 const originalExec=sql.exec;let assignmentRaceInjected=false;
 sql.exec=async function execWithAssignmentRace(source){
  if(!assignmentRaceInjected&&source.trim()==='BEGIN IMMEDIATE'){
   assignmentRaceInjected=true;
   await sql.prepare("UPDATE members SET tenant_id='beta' WHERE email=? AND tenant_id='main'").run('outsideclient@example.test');
  }
  return originalExec.call(sql,source);
 };
 let racedAssignment;
 try{racedAssignment=await form('/accounts/role',{id:ids.outsideclient,tenantId:'alpha',role:'employee'},ownerCookie);}
 finally{sql.exec=originalExec;}
 assert.equal(assignmentRaceInjected,true);assert.equal(racedAssignment.status,409);
 assert.equal((await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get('outsideclient@example.test')).tenant_id,'beta');
 assert.equal(await sql.prepare('SELECT user_id FROM portal_staff WHERE user_id=?').get(ids.outsideclient),undefined);
 const originalPrepare=sql.prepare;let insertRaceInjected=false;
 sql.prepare=function prepareWithInsertRace(source){
  const statement=originalPrepare.call(sql,source);
  if(source.startsWith("UPDATE members SET tenant_id=? WHERE email=? AND tenant_id='main'")){
   const originalRun=statement.run;
   statement.run=async function runWithInsertRace(tenantId,email){
    if(email==='insertclient@example.test'&&!insertRaceInjected){
     insertRaceInjected=true;
     await originalPrepare.call(sql,"UPDATE members SET tenant_id='beta' WHERE email=? AND tenant_id='main'").run(email);
    }
    return originalRun.call(statement,tenantId,email);
   };
  }
  return statement;
 };
 let insertRacedAssignment;
 try{insertRacedAssignment=await form('/accounts/role',{id:ids.insertclient,tenantId:'alpha',role:'employee'},ownerCookie);}
 finally{sql.prepare=originalPrepare;}
 assert.equal(insertRaceInjected,true);assert.equal(insertRacedAssignment.status,409);
 assert.equal((await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get('insertclient@example.test')).tenant_id,'main');
 assert.equal(await sql.prepare('SELECT user_id FROM portal_staff WHERE user_id=?').get(ids.insertclient),undefined);
 assert.equal((await post({action:'create-ticket',subject:'Alpha help',body:'Scoped request'},tenantClientCookie)).status,201);
 const alphaTicket=(await (await get(tenantClientCookie)).json()).tickets[0].id;
 assert.equal((await post({action:'update-ticket',id:alphaTicket,status:'已完成',reply:'Handled by employee'},staffCookie)).status,200);
 assert.equal((await post({action:'update-ticket',id:ticketId,status:'已完成',reply:'No'},staffCookie)).status,404);
 assert.equal((await form('/accounts/role',{id:ids.staffmember,tenantId:'alpha',role:'customer'},ownerCookie)).status,303);
 assert.equal(await sql.prepare('SELECT user_id FROM portal_finance_staff WHERE user_id=?').get(ids.staffmember),undefined);assert.equal(Number((await sql.prepare("SELECT count(*) AS n FROM audit WHERE action LIKE '职责变更撤销财务审核权限：%'").get()).n),1);
 assert.equal((await get(staffCookie)).status,401);
 const demoted=session(await form('/auth/login',{username:'staffmember',password}));assert.equal((await req('/admin',{headers:{cookie:demoted}})).status,403);
 assert.equal((await (await get(demoted)).json()).tickets.length,0);
 assert.equal((await req('/account')).status,303);
 assert.equal((await req('/account',{headers:{cookie:ownerCookie}})).status,200);
 assert.equal((await form('/account',{currentPassword:password,newPassword:'Changed-owner-password-8901',confirmPassword:'different'},ownerCookie)).status,400);
 assert.equal((await form('/account',{currentPassword:'Wrong-current-password-123',newPassword:'Changed-owner-password-8901',confirmPassword:'Changed-owner-password-8901'},ownerCookie)).status,400);
 assert.equal((await get(ownerCookie)).status,200);
 const changed=await form('/account',{currentPassword:password,newPassword:'Changed-owner-password-8901',confirmPassword:'Changed-owner-password-8901'},ownerCookie);assert.equal(changed.status,200);assert(changed.headers.get('set-cookie').includes('Max-Age=0'));
 const changedRecovery=(await changed.text()).match(/<code class="recovery">([^<]+)/)[1];assert(changedRecovery);assert.notEqual(changedRecovery,ownerRecovery);
 assert.equal((await get(ownerCookie)).status,401);
 assert.equal((await form('/auth/login',{username:'owner',password})).status,401);
 assert.equal((await form('/auth/reset',{username:'owner',recovery:ownerRecovery,password:'Other-owner-password-1001'})).status,400);
 const changedOwner=session(await form('/auth/login',{username:'owner',password:'Changed-owner-password-8901'}));assert.equal((await get(changedOwner)).status,200);
 (await sql.prepare('UPDATE portal_sessions SET expires_at=0').run());assert.equal((await get(ownerCookie)).status,401);
 if(postgresTest){
  const expected=Number((await sql.prepare('SELECT count(*) AS n FROM tickets').get()).n);
  await sql.close();
  await new Promise((resolve,reject)=>{
   const code="import {PGlite} from '@electric-sql/pglite';const db=new PGlite(process.env.PORTAL_TEST_POSTGRES_PATH);const r=await db.query('SELECT count(*) AS n FROM portal_private.tickets');if(Number(r.rows[0].n)!==Number(process.env.PORTAL_EXPECTED_TEST_TICKETS))throw Error('Postgres persistence mismatch');await db.close();";
   const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,PORTAL_EXPECTED_TEST_TICKETS:String(expected)},stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',d=>error+=d);child.on('close',status=>status?reject(Error(error)):resolve());child.on('error',reject);
  });
 }
 await sql.close();assert.equal((await req('/health')).status,503);
 console.log('PASS ['+(postgresTest?'PostgreSQL/PGlite':'SQLite')+']: real local HTTP registration/pending approval/login; owner approval; password hashing; session cookie security; unauthenticated rejection; customer/admin separation; request/reply persistence; tenant isolation; recovery rotation and session revocation; logout; suspension; expired sessions; CSP; built assets; headquarters provisioning; tenant owner isolation; employee restrictions; cross-tenant denial; role-change session revocation; Deposit request validation, exact minor units, idempotency and isolation; password change, old-session invalidation and recovery rotation; brand settings persistence, member visibility, legacy compatibility, validation, audit and tenant permissions; database readiness and unavailable response. Temporary test database only.');
}finally{await new Promise(r=>server.close(r));const {sql}=await import('./runtime.mjs');(await sql.close());rmSync(dir,{recursive:true,force:true});}
