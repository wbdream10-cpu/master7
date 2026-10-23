import {createHash,randomUUID} from 'node:crypto';
import {sql,withStorage} from './runtime.mjs';
import {limited} from './security.mjs';

const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const requestKeyPattern=/^[A-Za-z0-9_-]{16,100}$/;
const idPattern=/^[A-Za-z0-9_-]{1,100}$/;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cleanText=(value,min,max)=>{
 if(typeof value!=='string')return null;
 const result=value.trim().replace(/\s+/gu,' ');
 return result.length>=min&&result.length<=max&&!/[\u0000-\u001f\u007f]/u.test(result)?result:null;
};
const amountMinor=value=>{
 if(typeof value!=='string'||!/^(0|[1-9]\d{0,5})(\.\d{1,2})?$/.test(value))return null;
 const [major,decimal='']=value.split('.'),minor=Number(major)*100+Number(decimal.padEnd(2,'0'));
 return minor>0&&minor<=10000000?minor:null;
};
const enabled=env=>env.PORTAL_WITHDRAWALS_ENABLED==='true';

async function canonicalScope(user,selected){
 if(!user||typeof user.userId!=='string')return {error:json({error:'请先登录'},401)};
 if(selected!==null&&selected!==undefined&&(typeof selected!=='string'||selected.length>60||/[\u0000-\u001f\u007f]/u.test(selected)))return {error:json({error:'租户标识无效'},400)};
 const identity=await sql.prepare(`SELECT u.id,u.email,u.role,u.approved,p.tenant_id AS staff_tenant,p.role AS staff_role,m.tenant_id AS member_tenant
  FROM portal_users u LEFT JOIN portal_staff p ON p.user_id=u.id LEFT JOIN members m ON m.email=u.email WHERE u.id=?`).get(user.userId);
 if(!identity||!identity.approved)return {error:json({error:'账号不可用'},403)};
 const actualRole=identity.role==='owner'?'owner':identity.staff_role||'customer';
 if(actualRole!==user.role)return {error:json({error:'账号权限已变化，请重新登录'},403)};
 const bound=actualRole==='owner'?null:identity.staff_tenant||identity.member_tenant||'main';
 if(actualRole!=='owner'&&user.tenantId&&user.tenantId!==bound)return {error:json({error:'账号租户归属已变化，请重新登录'},403)};
 if(actualRole!=='owner'&&selected&&selected!==bound)return {error:json({error:'无权访问其他租户'},403)};
 const tenantId=actualRole==='owner'?(selected||'main'):bound;
 if(tenantId!=='main'&&!await sql.prepare('SELECT id FROM brands WHERE id=?').get(tenantId))return {error:json({error:'租户不存在'},404)};
 const manager=['owner','tenant_owner'].includes(actualRole);
 const finance=actualRole==='employee'&&Boolean(await sql.prepare('SELECT user_id FROM portal_finance_staff WHERE user_id=? AND tenant_id=?').get(identity.id,tenantId));
 return {tenantId,manager,finance,customer:actualRole==='customer',identity};
}

/** Settled balance, active holds and spendable amount. Caller must already own storage scope. */
export async function withdrawalWalletState(tenantId,userId){
 const credit=await sql.prepare("SELECT CAST(COALESCE(SUM(member_minor),0) AS TEXT) AS amount FROM portal_wallet_journal WHERE tenant_id=? AND user_id=? AND environment='production' AND currency='MYR'").get(tenantId,userId);
 const debit=await sql.prepare("SELECT CAST(COALESCE(SUM(member_minor),0) AS TEXT) AS amount FROM portal_wallet_withdrawal_journal WHERE tenant_id=? AND user_id=? AND environment='production' AND currency='MYR'").get(tenantId,userId);
 const held=await sql.prepare("SELECT CAST(COALESCE(SUM(amount_minor),0) AS TEXT) AS amount FROM portal_wallet_holds WHERE tenant_id=? AND user_id=? AND environment='production' AND currency='MYR' AND state='active'").get(tenantId,userId);
 const balance=BigInt(credit.amount)+BigInt(debit.amount),reserved=BigInt(held.amount),available=balance-reserved;
 return {balanceMinor:balance.toString(),heldMinor:reserved.toString(),availableMinor:available.toString()};
}

const withdrawalColumns=['id','tenant_id','user_id','request_key','request_fingerprint','environment','amount_minor','currency','bank_name','account_holder','account_number','status','payout_reference','resolution_reason','paid_at','created_at','updated_at'];
const projection=(alias='')=>withdrawalColumns.map(column=>alias+column).join(',');
const publicWithdrawal=row=>({
 id:row.id,tenantId:row.tenant_id,member:row.username||null,amountMinor:String(row.amount_minor),currency:row.currency,
 bank:{bankName:row.bank_name,accountHolder:row.account_holder,accountNumber:row.account_number},status:row.status,
 reference:row.payout_reference||null,reason:row.resolution_reason||null,createdAt:row.created_at,
 processingAt:row.processing_at||null,completedAt:row.completed_at||null,
});

function normalizeSubmission(data){
 const amount=amountMinor(data?.amount),bankName=cleanText(data?.bankName,2,80),accountHolder=cleanText(data?.accountHolder,2,100),accountNumber=cleanText(data?.accountNumber,4,34);
 if(amount===null||data?.currency!=='MYR'||!bankName||!accountHolder||!accountNumber||!/^[0-9 -]{4,34}$/.test(accountNumber)||!/[0-9]/.test(accountNumber)||!requestKeyPattern.test(data?.requestKey||''))return null;
 return {amountMinor:amount,currency:'MYR',bankName,accountHolder,accountNumber,requestKey:data.requestKey};
}
const submissionFingerprint=value=>hash({amountMinor:value.amountMinor,currency:value.currency,bankName:value.bankName,accountHolder:value.accountHolder,accountNumber:value.accountNumber});

function normalizeReview(data){
 if(!requestKeyPattern.test(data?.requestKey||'')||!['start','reject','paid','failed'].includes(data?.action))return null;
 const reason=data.reason===undefined||data.reason===null||data.reason===''?null:cleanText(data.reason,2,250);
 const reference=data.reference===undefined||data.reference===null||data.reference===''?null:cleanText(data.reference,4,100)?.toUpperCase();
 if((data.reason&&!reason)||(data.reference&&!reference))return null;
 if(data.action==='start'&&(reason||reference))return null;
 if(['reject','failed'].includes(data.action)&&(!reason||reference))return null;
 if(data.action==='paid'&&(!reference||reason||!/^[A-Z0-9 ._\/-]{4,100}$/.test(reference)))return null;
 return {action:data.action,requestKey:data.requestKey,reason,reference};
}
const reviewFingerprint=value=>hash({action:value.action,reason:value.reason,reference:value.reference});
const csvCell=value=>'"'+String(value??'').replace(/^[\u0000-\u0020]*[=+@\-]/,"'$&").replace(/"/g,'""')+'"';
const withdrawalStatuses=new Set(['pending_review','processing','paid','rejected','failed']);
const memberSearchPattern=/^[A-Za-z0-9_.-]{1,100}$/;
const pageSize=100;
const queuePriority="CASE w.status WHEN 'pending_review' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END";
const memberPriority='CASE WHEN w.id IS NULL THEN 1 ELSE 0 END';
const exactIso=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const shiftDate=(value,days)=>{const [year,month,day]=value.split('-').map(Number);return new Date(Date.UTC(year,month-1,day+days)).toISOString().slice(0,10);};
const localDate=value=>new Date(value.getTime()+8*3600000).toISOString().slice(0,10);
const cleanParams=params=>params instanceof URLSearchParams?params:new URLSearchParams();

function queryFilters(params,instant,{allowCursor=true,defaultRange=false}={}){
 const values=cleanParams(params),today=localDate(instant),providedFrom=values.get('from'),providedTo=values.get('to');
 const fromLocal=providedFrom||(defaultRange?shiftDate(today,-30):null),toLocal=providedTo||(defaultRange?today:null);
 const status=values.get('status')||'all',member=(values.get('member')||'').trim().toLowerCase(),cursor=values.get('cursor')||'';
 if(Boolean(fromLocal)!==Boolean(toLocal)||(fromLocal&&(!validDate(fromLocal)||!validDate(toLocal)||toLocal<fromLocal||Date.parse(toLocal)-Date.parse(fromLocal)>30*86400000)))return {error:'日期无效；请同时选择开始与结束日期，最多 31 天（Asia/Kuching）'};
 if(status!=='all'&&!withdrawalStatuses.has(status))return {error:'提现状态筛选无效'};
 if(member&&!memberSearchPattern.test(member))return {error:'会员搜索只可使用字母、数字、点、连字号或底线'};
 if(cursor&&(!allowCursor||cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(cursor)))return {error:allowCursor?'分页标识无效':'导出不能使用分页标识'};
 return {status,member,fromLocal,toLocal,from:fromLocal?new Date(fromLocal+'T00:00:00+08:00').toISOString():null,to:toLocal?new Date(shiftDate(toLocal,1)+'T00:00:00+08:00').toISOString():null,timeZone:'Asia/Kuching',cursor};
}

function filteredWhere(scope,reviewer,filters){
 const clauses=['w.tenant_id=?'],values=[scope.tenantId];
 if(filters.from){clauses.push('w.created_at>=?','w.created_at<?');values.push(filters.from,filters.to);}
 if(!reviewer){clauses.push('w.user_id=?');values.push(scope.identity.id);}
 if(filters.status!=='all'){clauses.push('w.status=?');values.push(filters.status);}
 if(filters.member){clauses.push("LOWER(u.username) LIKE ? ESCAPE '!'");values.push('%'+filters.member.replaceAll('_','!_')+'%');}
 return {sql:clauses.join(' AND '),values};
}

function cursorFor(scope,reviewer,filters,last){
 return Buffer.from(JSON.stringify({p:reviewer?Number(last.queue_priority):0,at:last.created_at,id:last.id,s:hash({tenantId:scope.tenantId,userId:reviewer?'*':scope.identity.id,status:filters.status,member:filters.member,from:filters.fromLocal,to:filters.toLocal,sort:reviewer?'queue':'member'})})).toString('base64url');
}

function parseCursor(scope,reviewer,filters){
 if(!filters.cursor)return null;
 try{
  const value=JSON.parse(Buffer.from(filters.cursor,'base64url').toString()),expected=hash({tenantId:scope.tenantId,userId:reviewer?'*':scope.identity.id,status:filters.status,member:filters.member,from:filters.fromLocal,to:filters.toLocal,sort:reviewer?'queue':'member'});
  if(!Number.isInteger(value.p)||value.p<0||value.p>2||(!reviewer&&value.p!==0)||!exactIso.test(value.at)||!idPattern.test(value.id)||value.s!==expected)throw Error();
  return value;
 }catch{return false;}
}

export function createWithdrawals({env=process.env,now=()=>new Date(),rateLimit=limited}={}){
 const currentTime=()=>{const value=now();if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw new TypeError('Invalid withdrawal clock');return value;};

 async function configuration(user,selected=null){return withStorage(async()=>{
  const scope=await canonicalScope(user,selected);if(scope.error)return scope.error;
  if(!scope.customer&&!scope.manager&&!scope.finance)return json({error:'没有提现资料权限'},403);
  const wallet=scope.customer?await withdrawalWalletState(scope.tenantId,scope.identity.id):{balanceMinor:null,heldMinor:null,availableMinor:null};
  return json({tenantId:scope.tenantId,enabled:enabled(env),currency:'MYR',...wallet,postedBalanceMinor:wallet.balanceMinor,canReview:scope.manager||scope.finance});
 });}

 async function list(user,selected=null,params=new URLSearchParams()){return withStorage(async()=>{
  const scope=await canonicalScope(user,selected);if(scope.error)return scope.error;
  if(!scope.customer&&!scope.manager&&!scope.finance)return json({error:'没有提现记录权限'},403);
  const reviewer=scope.manager||scope.finance,filters=queryFilters(params,currentTime());
  if(filters.error)return json({error:filters.error},400);
  const cursor=parseCursor(scope,reviewer,filters);if(cursor===false)return json({error:'分页标识无效或与当前筛选不一致'},400);
  const where=filteredWhere(scope,reviewer,filters),priority=reviewer?queuePriority:memberPriority,cursorSql=cursor?` AND (${priority}>? OR (${priority}=? AND (w.created_at<? OR (w.created_at=? AND w.id<?))))`:'';
  const cursorValues=cursor?[cursor.p,cursor.p,cursor.at,cursor.at,cursor.id]:[];
  const rows=await sql.prepare(`SELECT ${projection('w.')},u.username,${priority} AS queue_priority,
   (SELECT a.created_at FROM portal_withdrawal_actions a WHERE a.withdrawal_id=w.id AND a.action='start_processing' ORDER BY a.created_at,a.id LIMIT 1) AS processing_at,
   (SELECT a.created_at FROM portal_withdrawal_actions a WHERE a.withdrawal_id=w.id AND a.action IN ('mark_paid','reject','fail') ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS completed_at
   FROM portal_withdrawal_requests w JOIN portal_users u ON u.id=w.user_id
   WHERE ${where.sql}${cursorSql} ORDER BY ${priority} ASC,w.created_at DESC,w.id DESC LIMIT ${pageSize+1}`).all(...where.values,...cursorValues);
  const totals=await sql.prepare(`SELECT w.status,count(*) AS count,CAST(COALESCE(SUM(w.amount_minor),0) AS TEXT) AS amount
   FROM portal_withdrawal_requests w JOIN portal_users u ON u.id=w.user_id WHERE ${where.sql} GROUP BY w.status`).all(...where.values);
  const statuses=Object.fromEntries([...withdrawalStatuses].map(status=>[status,{count:0,amountMinor:'0'}]));
  for(const row of totals)statuses[row.status]={count:Number(row.count),amountMinor:String(row.amount)};
  const totalCount=totals.reduce((sum,row)=>sum+Number(row.count),0),totalMinor=totals.reduce((sum,row)=>sum+BigInt(row.amount),0n).toString();
  const page=rows.slice(0,pageSize),last=page.at(-1);
  return json({tenantId:scope.tenantId,enabled:enabled(env),canReview:reviewer,withdrawals:page.map(publicWithdrawal),nextCursor:rows.length>pageSize?cursorFor(scope,reviewer,filters,last):null,
   filters:{status:filters.status,member:filters.member,from:filters.fromLocal,to:filters.toLocal,timeZone:filters.timeZone},summary:{count:totalCount,amountMinor:totalMinor,statuses}});
 });}

 async function submit(user,selected,data){return withStorage(async()=>{
  const scope=await canonicalScope(user,selected);if(scope.error)return scope.error;
  if(!scope.customer)return json({error:'只有会员可以提交本人提现'},403);
  const value=normalizeSubmission(data);if(!value)return json({error:'请检查提现金额、银行、户口名字和户口号码'},400);
  const fingerprint=submissionFingerprint(value);
  const old=await sql.prepare(`SELECT ${projection()} FROM portal_withdrawal_requests WHERE user_id=? AND request_key=?`).get(scope.identity.id,value.requestKey);
  if(old)return old.request_fingerprint===fingerprint?json({withdrawal:publicWithdrawal(old),duplicate:true}):json({error:'请求标识已用于其他提现'},409);
  if(!enabled(env))return json({error:'WITHDRAWALS_NOT_OPEN'},409);
  if(await rateLimit('withdrawal:'+scope.identity.id,10))return json({error:'提交过于频繁，请稍后再试'},429);
  const at=currentTime().toISOString(),id=randomUUID();
  await sql.exec('BEGIN IMMEDIATE');try{
   // A no-op write takes the member row lock on PostgreSQL and keeps the
   // balance check plus hold insertion atomic across multiple app workers.
   const locked=await sql.prepare("UPDATE portal_users SET approved=approved WHERE id=? AND role='customer' AND approved=1").run(scope.identity.id);
   if(!locked.changes)throw Object.assign(Error('MEMBER_UNAVAILABLE'),{publicStatus:409});
   const current=await canonicalScope(user,selected);
   if(current.error||!current.customer||current.tenantId!==scope.tenantId)throw Object.assign(Error('MEMBER_UNAVAILABLE'),{publicStatus:409});
   const wallet=await withdrawalWalletState(scope.tenantId,scope.identity.id);
   if(BigInt(wallet.availableMinor)<BigInt(value.amountMinor))throw Object.assign(Error('INSUFFICIENT_AVAILABLE_BALANCE'),{publicStatus:409});
   await sql.prepare(`INSERT INTO portal_withdrawal_requests(id,tenant_id,user_id,request_key,request_fingerprint,environment,amount_minor,currency,bank_name,account_holder,account_number,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'production',?,?,?,?,?,'pending_review',?,?)`).run(id,scope.tenantId,scope.identity.id,value.requestKey,fingerprint,value.amountMinor,'MYR',value.bankName,value.accountHolder,value.accountNumber,at,at);
   await sql.prepare(`INSERT INTO portal_wallet_holds(withdrawal_id,tenant_id,user_id,environment,currency,amount_minor,state,created_at,updated_at)
    VALUES (?,?,?,'production','MYR',?,'active',?,?)`).run(id,scope.tenantId,scope.identity.id,value.amountMinor,at,at);
   await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),scope.tenantId,scope.identity.email,'提交人工提现申请：'+id,at);
   await sql.exec('COMMIT');
  }catch(error){
   await sql.exec('ROLLBACK');
   const retry=await sql.prepare(`SELECT ${projection()} FROM portal_withdrawal_requests WHERE user_id=? AND request_key=?`).get(scope.identity.id,value.requestKey);
   if(retry)return retry.request_fingerprint===fingerprint?json({withdrawal:publicWithdrawal(retry),duplicate:true}):json({error:'请求标识已用于其他提现'},409);
   if(error.message==='INSUFFICIENT_AVAILABLE_BALANCE')return json({error:'可用余额不足'},409);
   if(error.message==='MEMBER_UNAVAILABLE')return json({error:'会员账号或归属已变化'},409);
   throw error;
  }
  const created=await sql.prepare(`SELECT ${projection()} FROM portal_withdrawal_requests WHERE id=?`).get(id);
  return json({withdrawal:publicWithdrawal(created),duplicate:false},201);
 });}

 async function review(user,selected,id,data){return withStorage(async()=>{
  const scope=await canonicalScope(user,selected);if(scope.error)return scope.error;
  if(!scope.manager&&!scope.finance)return json({error:'没有财务审核权限'},403);
  if(!idPattern.test(id||''))return json({error:'提现编号无效'},400);
  const value=normalizeReview(data);if(!value)return json({error:'请检查财务动作、请求标识、原因或银行参考号'},400);
  const fingerprint=reviewFingerprint(value);
  const oldAction=await sql.prepare('SELECT * FROM portal_withdrawal_actions WHERE actor_id=? AND request_key=?').get(scope.identity.id,value.requestKey);
  if(oldAction){
   if(oldAction.withdrawal_id!==id||oldAction.request_fingerprint!==fingerprint)return json({error:'财务请求标识已用于其他操作'},409);
   const old=await sql.prepare(`SELECT ${projection('w.')},u.username,
    (SELECT a.created_at FROM portal_withdrawal_actions a WHERE a.withdrawal_id=w.id AND a.action='start_processing' ORDER BY a.created_at,a.id LIMIT 1) AS processing_at,
    (SELECT a.created_at FROM portal_withdrawal_actions a WHERE a.withdrawal_id=w.id AND a.action IN ('mark_paid','reject','fail') ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS completed_at
    FROM portal_withdrawal_requests w JOIN portal_users u ON u.id=w.user_id WHERE w.id=? AND w.tenant_id=?`).get(id,scope.tenantId);
   return old?json({withdrawal:publicWithdrawal(old),duplicate:true}):json({error:'提现记录不存在'},404);
  }
  const transitions={start:['pending_review','processing','start_processing'],reject:['pending_review','rejected','reject'],paid:['processing','paid','mark_paid'],failed:['processing','failed','fail']};
  const [from,to,storedAction]=transitions[value.action],at=currentTime().toISOString();
  await sql.exec('BEGIN IMMEDIATE');try{
   const row=await sql.prepare(`SELECT ${projection()} FROM portal_withdrawal_requests WHERE id=? AND tenant_id=?`).get(id,scope.tenantId);
   if(!row)throw Object.assign(Error('NOT_FOUND'),{publicStatus:404});
   // Serialize every action with new submissions for this wallet.
   await sql.prepare('UPDATE portal_users SET approved=approved WHERE id=?').run(row.user_id);
   if(row.status!==from)throw Object.assign(Error('STATE_CONFLICT'),{publicStatus:409});
   if(['start','paid'].includes(value.action)){
    const member=await sql.prepare("SELECT COALESCE(m.tenant_id,'main') AS tenant_id FROM portal_users u LEFT JOIN members m ON m.email=u.email LEFT JOIN portal_staff p ON p.user_id=u.id WHERE u.id=? AND u.role='customer' AND u.approved=1 AND p.user_id IS NULL").get(row.user_id);
    if(!member||member.tenant_id!==row.tenant_id)throw Object.assign(Error('MEMBER_UNAVAILABLE'),{publicStatus:409});
   }
   let changed;
   if(value.action==='start')changed=await sql.prepare("UPDATE portal_withdrawal_requests SET status='processing',updated_at=? WHERE id=? AND tenant_id=? AND status='pending_review'").run(at,id,scope.tenantId);
   else if(value.action==='reject')changed=await sql.prepare("UPDATE portal_withdrawal_requests SET status='rejected',resolution_reason=?,updated_at=? WHERE id=? AND tenant_id=? AND status='pending_review'").run(value.reason,at,id,scope.tenantId);
   else if(value.action==='failed')changed=await sql.prepare("UPDATE portal_withdrawal_requests SET status='failed',resolution_reason=?,updated_at=? WHERE id=? AND tenant_id=? AND status='processing'").run(value.reason,at,id,scope.tenantId);
   else{
    changed=await sql.prepare("UPDATE portal_withdrawal_requests SET status='paid',payout_reference=?,paid_at=?,updated_at=? WHERE id=? AND tenant_id=? AND status='processing'").run(value.reference,at,at,id,scope.tenantId);
    if(changed.changes)await sql.prepare(`INSERT INTO portal_wallet_withdrawal_journal(id,withdrawal_id,tenant_id,user_id,environment,currency,member_minor,clearing_minor,created_at)
     VALUES (?,?,?,?,?,'MYR',?,?,?)`).run(randomUUID(),id,row.tenant_id,row.user_id,'production',-Number(row.amount_minor),Number(row.amount_minor),at);
   }
   if(!changed.changes)throw Object.assign(Error('STATE_CONFLICT'),{publicStatus:409});
   const holdState=value.action==='paid'?'consumed':(['reject','failed'].includes(value.action)?'released':null);
   if(holdState){
    const hold=holdState==='consumed'
     ?await sql.prepare("UPDATE portal_wallet_holds SET state='consumed',updated_at=?,consumed_at=? WHERE withdrawal_id=? AND state='active'").run(at,at,id)
     :await sql.prepare("UPDATE portal_wallet_holds SET state='released',updated_at=?,released_at=? WHERE withdrawal_id=? AND state='active'").run(at,at,id);
    if(hold.changes!==1)throw Error('WITHDRAWAL_HOLD_CONFLICT');
   }
   await sql.prepare(`INSERT INTO portal_withdrawal_actions(id,withdrawal_id,tenant_id,actor_id,request_key,request_fingerprint,action,reason,payout_reference,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),id,scope.tenantId,scope.identity.id,value.requestKey,fingerprint,storedAction,value.reason,value.reference,at);
   const labels={start:'财务开始处理人工提现',reject:'财务拒绝人工提现',paid:'财务确认人工提现已付款并扣账',failed:'财务标记人工提现失败并释放冻结'};
   await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),scope.tenantId,scope.identity.email,labels[value.action]+'：'+id,at);
   await sql.exec('COMMIT');
  }catch(error){
   await sql.exec('ROLLBACK');
   const retry=await sql.prepare('SELECT * FROM portal_withdrawal_actions WHERE actor_id=? AND request_key=?').get(scope.identity.id,value.requestKey);
   if(retry)return retry.withdrawal_id===id&&retry.request_fingerprint===fingerprint?review(user,selected,id,data):json({error:'财务请求标识已用于其他操作'},409);
   if(error.message==='NOT_FOUND')return json({error:'提现记录不存在'},404);
   if(error.message==='STATE_CONFLICT')return json({error:'提现状态已变化，请刷新后重试'},409);
   if(error.message==='WITHDRAWAL_HOLD_CONFLICT')return json({error:'提现冻结状态异常，请停止付款并交由财务复核'},409);
   if(error.message==='MEMBER_UNAVAILABLE')return json({error:'会员账号或归属已变化，不能继续付款'},409);
   if(value.action==='paid'&&await sql.prepare('SELECT id FROM portal_withdrawal_requests WHERE tenant_id=? AND payout_reference=?').get(scope.tenantId,value.reference))return json({error:'银行付款参考号已用于其他提现'},409);
   throw error;
  }
  const updated=await sql.prepare(`SELECT ${projection('w.')},u.username,
   (SELECT a.created_at FROM portal_withdrawal_actions a WHERE a.withdrawal_id=w.id AND a.action='start_processing' ORDER BY a.created_at,a.id LIMIT 1) AS processing_at,
   (SELECT a.created_at FROM portal_withdrawal_actions a WHERE a.withdrawal_id=w.id AND a.action IN ('mark_paid','reject','fail') ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS completed_at
   FROM portal_withdrawal_requests w JOIN portal_users u ON u.id=w.user_id WHERE w.id=?`).get(id);
  return json({withdrawal:publicWithdrawal(updated),duplicate:false});
 });}

 async function exportRecords(user,selected=null,params=new URLSearchParams()){return withStorage(async()=>{
  const scope=await canonicalScope(user,selected);if(scope.error)return scope.error;
  if(!scope.manager&&!scope.finance)return json({error:'只有获授权财务人员或管理员可以导出'},403);
  const filters=queryFilters(params,currentTime(),{allowCursor:false,defaultRange:true});if(filters.error)return json({error:filters.error},400);
  const where=filteredWhere(scope,true,filters);
  const rows=await sql.prepare(`SELECT ${projection('w.')},u.username,
   (SELECT a.created_at FROM portal_withdrawal_actions a WHERE a.withdrawal_id=w.id AND a.action='start_processing' ORDER BY a.created_at,a.id LIMIT 1) AS processing_at,
   (SELECT a.created_at FROM portal_withdrawal_actions a WHERE a.withdrawal_id=w.id AND a.action IN ('mark_paid','reject','fail') ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS completed_at
   FROM portal_withdrawal_requests w JOIN portal_users u ON u.id=w.user_id
   WHERE ${where.sql} ORDER BY ${queuePriority} ASC,w.created_at DESC,w.id DESC LIMIT 10001`).all(...where.values);
  if(rows.length>10000)return json({error:'记录超过 10000 条，请缩短日期范围或增加筛选'},413);
  const at=currentTime().toISOString();
  await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),scope.tenantId,scope.identity.email,'导出人工提现记录：'+filters.fromLocal+' 至 '+filters.toLocal+' / '+filters.status+' / '+(filters.member||'全部会员')+' / '+rows.length+' 条',at);
  const headers=['提现编号','会员','金额（分）','币种','银行','户口名字','户口号码','状态','银行参考号','处理原因','提交时间（UTC）','开始处理时间（UTC）','完成时间（UTC）'];
  const lines=rows.map(publicWithdrawal).map(item=>[item.id,item.member,item.amountMinor,item.currency,item.bank.bankName,item.bank.accountHolder,item.bank.accountNumber,item.status,item.reference,item.reason,item.createdAt,item.processingAt,item.completedAt].map(csvCell).join(','));
  return new Response('\ufeff'+[headers.map(csvCell).join(','),...lines].join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="master7-withdrawals.csv"','Cache-Control':'no-store'}});
 });}

 return {configuration,list,submit,review,exportRecords};
}
