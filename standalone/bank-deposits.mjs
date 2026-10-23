import {createHash,randomUUID} from 'node:crypto';
import {sql,withStorage} from './runtime.mjs';
import {limited} from './security.mjs';
import {createUnsignedVPayOrder} from './vpay-contract.mjs';

export const MAX_BANK_RECEIPT_BYTES=2*1024*1024;
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const idPattern=/^[A-Za-z0-9_-]{1,100}$/;
const requestKeyPattern=/^[A-Za-z0-9_-]{16,100}$/;
const receiptTypes=new Set(['image/jpeg','image/png','image/webp']);
const receiptExtensions={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
const hash=value=>createHash('sha256').update(value).digest('hex');
const exactTime=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const text=(value,min,max)=>{
 if(typeof value!=='string')return null;
 const result=value.trim().replace(/\s+/gu,' ');
 return result.length>=min&&result.length<=max&&!/[\u0000-\u001f\u007f]/u.test(result)?result:null;
};
const amountMinor=value=>{
 if(typeof value!=='string'||!/^(0|[1-9]\d{0,5})(\.\d{1,2})?$/.test(value))return null;
 const [major,decimal='']=value.split('.'),minor=Number(major)*100+Number(decimal.padEnd(2,'0'));
 return minor>0&&minor<=10000000?minor:null;
};
const digestObject=value=>hash(Buffer.from(JSON.stringify(value)));
function vpayProductionReady(env){
 try{
  const codes=JSON.parse(env.PORTAL_VPAY_TRADE_CODES||'[]'),tokenNames=['PORTAL_VPAY_CALLBACK_TOKEN','PORTAL_VPAY_QUERY_TOKEN','PORTAL_VPAY_ORDER_TOKEN'];
  if(env.PORTAL_VPAY_ORDERS_ENABLED!=='true'||env.PORTAL_VPAY_SETTLEMENT_ENABLED!=='true'||env.PORTAL_VPAY_ENVIRONMENT!=='production'||!Array.isArray(codes)||!codes.length||new Set(codes).size!==codes.length)return false;
  const validToken=name=>typeof env[name]==='string'&&Buffer.byteLength(env[name])>=32&&Buffer.byteLength(env[name])<=1024;
  if(!tokenNames.every(validToken)||new Set(tokenNames.map(name=>env[name])).size!==tokenNames.length)return false;
  createUnsignedVPayOrder({traderId:env.PORTAL_VPAY_TRADER_ID,outTradeNo:'configuration_check',amount:'1.00',currency:'MYR',tradeCode:codes[0],title:'MASTER7 deposit',payerName:'CONFIGURATION CHECK',notifyUrl:'https://master7-integration-gateway.onrender.com/callbacks/vpay/payment',callbackUrl:env.PORTAL_VPAY_RETURN_URL},{traderId:env.PORTAL_VPAY_TRADER_ID,enabledTradeCodes:codes,notifyOrigin:'https://master7-integration-gateway.onrender.com',callbackOrigin:env.PUBLIC_ORIGIN});
  return true;
 }catch{return false;}
}

export class BankReceiptUploadError extends Error{
 constructor(code,status){super(code);this.code=code;this.status=status;}
}

/** Reads the private image body without weakening the server's normal 16 KiB limit. */
export async function readBankReceiptBody(request){
 const declared=String(request.headers?.['content-length']||'');
 if(declared&&(/^\d+$/.test(declared)===false||Number(declared)>MAX_BANK_RECEIPT_BYTES))throw new BankReceiptUploadError('BANK_RECEIPT_TOO_LARGE',413);
 const chunks=[];let size=0;
 for await(const chunk of request){
  size+=chunk.length;
  if(size>MAX_BANK_RECEIPT_BYTES)throw new BankReceiptUploadError('BANK_RECEIPT_TOO_LARGE',413);
  chunks.push(chunk);
 }
 if(!size)throw new BankReceiptUploadError('BANK_RECEIPT_EMPTY',400);
 return Buffer.concat(chunks,size);
}

const pngCrcTable=Uint32Array.from({length:256},(_,value)=>{let crc=value;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);return crc>>>0;});
function pngCrc(body,start,end){let crc=0xffffffff;for(let offset=start;offset<end;offset++)crc=(crc>>>8)^pngCrcTable[(crc^body[offset])&0xff];return (crc^0xffffffff)>>>0;}
function pngDimensions(body){
 let offset=8,dimensions=null,first=true,idat=false;
 while(offset+12<=body.length){
  const length=body.readUInt32BE(offset),typeStart=offset+4,dataStart=offset+8,dataEnd=dataStart+length,next=dataEnd+4;
  if(dataEnd<dataStart||next>body.length||pngCrc(body,typeStart,dataEnd)!==body.readUInt32BE(dataEnd))return null;
  const type=body.subarray(typeStart,dataStart).toString('ascii');
  if(first){
   if(type!=='IHDR'||length!==13)return null;
   const width=body.readUInt32BE(dataStart),height=body.readUInt32BE(dataStart+4),depth=body[dataStart+8],color=body[dataStart+9];
   const depths={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
   if(!width||!height||!depths[color]?.includes(depth)||body[dataStart+10]!==0||body[dataStart+11]!==0||![0,1].includes(body[dataStart+12]))return null;
   dimensions={width,height};first=false;
  }else if(type==='IHDR')return null;
  if(type==='IDAT'){if(!length)return null;idat=true;}
  if(type==='IEND')return length===0&&idat&&next===body.length?dimensions:null;
  offset=next;
 }
 return null;
}
function webpDimensions(body){
 let offset=12,first=true,dimensions=null,image=false;
 while(offset+8<=body.length){
  const kind=body.subarray(offset,offset+4).toString('ascii'),length=body.readUInt32LE(offset+4),data=offset+8,end=data+length,next=end+(length&1);
  if(end<data||next>body.length)return null;
  if(first){
   if(kind==='VP8X'){
    if(length!==10||body[data+1]||body[data+2]||body[data+3])return null;
    dimensions={width:1+body.readUIntLE(data+4,3),height:1+body.readUIntLE(data+7,3)};
   }else if(kind==='VP8L'){
    if(length<5||body[data]!==0x2f)return null;const a=body[data+1],b=body[data+2],c=body[data+3],d=body[data+4];
    dimensions={width:1+(a|((b&0x3f)<<8)),height:1+((b>>6)|(c<<2)|((d&0x0f)<<10))};image=true;
   }else if(kind==='VP8 '){
    if(length<10||body[data+3]!==0x9d||body[data+4]!==0x01||body[data+5]!==0x2a)return null;
    dimensions={width:body.readUInt16LE(data+6)&0x3fff,height:body.readUInt16LE(data+8)&0x3fff};image=true;
   }else return null;
   first=false;
  }else if(kind==='VP8X')return null;
  if(kind==='VP8 '){if(length<10||body[data+3]!==0x9d||body[data+4]!==0x01||body[data+5]!==0x2a)return null;image=true;}
  if(kind==='VP8L'){if(length<5||body[data]!==0x2f)return null;image=true;}
  if(kind==='ANMF'){if(length<16)return null;image=true;}
  offset=next;
 }
 return offset===body.length&&dimensions&&image?dimensions:null;
}
function jpegDimensions(body){
 let offset=2,dimensions=null;
 while(offset<body.length-2){
  if(body[offset]!==0xff)return null;
  while(offset<body.length-2&&body[offset]===0xff)offset++;
  const marker=body[offset++];
  if(marker===0xd9)return null;
  if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
  if(offset+2>body.length-2)return null;
  const length=body.readUInt16BE(offset);if(length<2||offset+length>body.length-2)return null;
  if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
   if(length<8)return null;const components=body[offset+7];if(!components||length<8+components*3)return null;
   dimensions={width:body.readUInt16BE(offset+5),height:body.readUInt16BE(offset+3)};
  }
  if(marker===0xda)return dimensions;
  offset+=length;
 }
 return null;
}
function imageDimensions(body,mime){return mime==='image/png'?pngDimensions(body):mime==='image/webp'?webpDimensions(body):mime==='image/jpeg'?jpegDimensions(body):null;}

function receiptMime(body,declared){
 if(!Buffer.isBuffer(body)||body.length<16||body.length>MAX_BANK_RECEIPT_BYTES)return null;
 const contentType=String(declared||'').split(';')[0].trim().toLowerCase();
 if(!receiptTypes.has(contentType))return null;
 let detected=null;
 if(body[0]===0xff&&body[1]===0xd8&&body[2]===0xff&&body.at(-2)===0xff&&body.at(-1)===0xd9)detected='image/jpeg';
 else if(body.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))detected='image/png';
 else if(body.subarray(0,4).toString('ascii')==='RIFF'&&body.subarray(8,12).toString('ascii')==='WEBP'&&body.readUInt32LE(4)+8===body.length&&['VP8 ','VP8L','VP8X'].includes(body.subarray(12,16).toString('ascii')))detected='image/webp';
 if(detected!==contentType)return null;
 const dimensions=imageDimensions(body,detected);
 if(!dimensions||dimensions.width<1||dimensions.height<1||dimensions.width>16384||dimensions.height>16384||dimensions.width*dimensions.height>24000000)return null;
 return detected;
}

async function canonicalScope(user,selected){
 if(!user||typeof user.userId!=='string')return {error:json({error:'请先登录'},401)};
 if(selected!==null&&selected!==undefined&&(typeof selected!=='string'||selected.length>60||/[\u0000-\u001f\u007f]/u.test(selected)))return {error:json({error:'租户标识无效'},400)};
 const identity=await sql.prepare(`SELECT u.id,u.email,u.role,u.approved,p.tenant_id AS staff_tenant,p.role AS staff_role,m.tenant_id AS member_tenant
  FROM portal_users u LEFT JOIN portal_staff p ON p.user_id=u.id LEFT JOIN members m ON m.email=u.email WHERE u.id=?`).get(user.userId);
 if(!identity||!identity.approved)return {error:json({error:'账号不可用'},403)};
 const actualRole=identity.role==='owner'?'owner':identity.staff_role||'customer';
 if(actualRole!==user.role)return {error:json({error:'账号权限已变化，请重新登录'},403)};
 const bound=actualRole==='owner'?null:identity.staff_tenant||identity.member_tenant||'main';
 if(actualRole!=='owner'&&selected&&selected!==bound)return {error:json({error:'无权访问其他租户'},403)};
 const tenantId=actualRole==='owner'?(selected||'main'):bound;
 if(tenantId!=='main'&&!await sql.prepare('SELECT id FROM brands WHERE id=?').get(tenantId))return {error:json({error:'租户不存在'},404)};
 const manager=['owner','tenant_owner'].includes(actualRole);
 const finance=actualRole==='employee'&&Boolean(await sql.prepare('SELECT user_id FROM portal_finance_staff WHERE user_id=? AND tenant_id=?').get(identity.id,tenantId));
 return {tenantId,manager,finance,customer:actualRole==='customer',identity};
}

const receiptMeta=row=>row.receipt_sha256?{present:true,mimeType:row.receipt_mime,size:Number(row.receipt_size),sha256:row.receipt_sha256,uploadedAt:row.receipt_uploaded_at}:{present:false};
// Private receipt bytes are deliberately absent. Every non-download query uses
// this projection so listing, idempotency and review paths cannot materialize
// up to 2 MiB per row in application memory.
const depositColumns=['id','tenant_id','user_id','request_key','request_fingerprint','amount_minor','currency','payer_name','transfer_reference','transferred_at','recipient_bank_name','recipient_account_holder','recipient_account_number','bank_config_updated_at','status','receipt_mime','receipt_size','receipt_sha256','receipt_uploaded_at','review_request_key','review_fingerprint','review_decision','review_reason','reviewed_by','reviewed_at','wallet_order_id','created_at'];
const depositProjection=(alias='')=>depositColumns.map(column=>alias+column).join(',');
const publicDeposit=row=>({
 id:row.id,tenantId:row.tenant_id,member:row.username||null,amountMinor:Number(row.amount_minor),currency:row.currency,
 payerName:row.payer_name,transferReference:row.transfer_reference,transferredAt:row.transferred_at,
 recipient:{bankName:row.recipient_bank_name,accountHolder:row.recipient_account_holder,accountNumber:row.recipient_account_number,configuredAt:row.bank_config_updated_at},
 status:row.status,receipt:receiptMeta(row),reviewReason:row.review_reason||null,reviewedAt:row.reviewed_at||null,
 walletOrderId:row.wallet_order_id||null,createdAt:row.created_at,
});

function normalizedConfiguration(data){
 const bankName=text(data?.bankName,2,80),accountHolder=text(data?.accountHolder,2,100),accountNumber=text(data?.accountNumber,4,34);
 if(!bankName||!accountHolder||!accountNumber||!/^[0-9 -]{4,34}$/.test(accountNumber)||!/[0-9]/.test(accountNumber)||typeof data?.enabled!=='boolean')return null;
 return {bankName,accountHolder,accountNumber,enabled:data.enabled};
}

function normalizedSubmission(data,now){
 const amount=amountMinor(data?.amount),payerName=text(data?.payerName,2,100),reference=text(data?.transferReference,4,100)?.toUpperCase(),transferredAt=data?.transferredAt,bankConfigUpdatedAt=data?.bankConfigUpdatedAt;
 if(amount===null||data?.currency!=='MYR'||!payerName||!reference||!/^[A-Z0-9 ._\/-]{4,100}$/.test(reference)||!/[A-Z0-9]/.test(reference)||!exactTime(transferredAt)||!exactTime(bankConfigUpdatedAt)||!requestKeyPattern.test(data?.requestKey||''))return null;
 const timestamp=Date.parse(transferredAt),current=now.getTime();
 if(timestamp>current+10*60*1000||timestamp<current-30*86400000)return null;
 return {amountMinor:amount,currency:'MYR',payerName,transferReference:reference,transferredAt,bankConfigUpdatedAt,requestKey:data.requestKey};
}

function submissionFingerprint(data,account){
 return digestObject({amountMinor:data.amountMinor,currency:data.currency,payerName:data.payerName,transferReference:data.transferReference,transferredAt:data.transferredAt,displayedBankConfigUpdatedAt:data.bankConfigUpdatedAt,
  recipientBankName:account.bank_name,recipientAccountHolder:account.account_holder,recipientAccountNumber:account.account_number,bankConfigUpdatedAt:account.updated_at});
}

export function createBankDeposits({now=()=>new Date(),rateLimit=limited,env=process.env}={}){
 const currentTime=()=>{const value=now();if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw new TypeError('Invalid bank deposit clock');return value;};

 async function getConfiguration(user,selected=null){return withStorage(async()=>{
  const scope=await canonicalScope(user,selected);if(scope.error)return scope.error;
  if(!scope.customer&&!scope.manager&&!scope.finance)return json({error:'没有银行转账资料权限'},403);
  const row=await sql.prepare('SELECT * FROM portal_bank_accounts WHERE tenant_id=?').get(scope.tenantId),visible=Boolean(row&&(row.enabled||scope.manager||scope.finance));
  return json({tenantId:scope.tenantId,enabled:Boolean(row?.enabled),bankAccount:visible?{bankName:row.bank_name,accountHolder:row.account_holder,accountNumber:row.account_number,updatedAt:row.updated_at}:null,canConfigure:scope.manager,canReview:scope.manager||scope.finance});
 });}

 async function saveConfiguration(user,selected,data){return withStorage(async()=>{
  const scope=await canonicalScope(user,selected);if(scope.error)return scope.error;
  if(!scope.manager)return json({error:'只有总部或租户老板可以设置收款银行'},403);
  const value=normalizedConfiguration(data);if(!value)return json({error:'请填写有效银行名称、户口名字和户口号码'},400);
  const at=currentTime().toISOString();await sql.exec('BEGIN IMMEDIATE');try{
   await sql.prepare(`INSERT INTO portal_bank_accounts(tenant_id,bank_name,account_holder,account_number,enabled,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET bank_name=excluded.bank_name,account_holder=excluded.account_holder,account_number=excluded.account_number,enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).run(scope.tenantId,value.bankName,value.accountHolder,value.accountNumber,value.enabled?1:0,scope.identity.id,at);
   await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),scope.tenantId,scope.identity.email,(value.enabled?'启用':'停用')+'银行转账收款资料',at);
   await sql.exec('COMMIT');
  }catch(error){await sql.exec('ROLLBACK');throw error;}
  return json({tenantId:scope.tenantId,enabled:value.enabled,bankAccount:{bankName:value.bankName,accountHolder:value.accountHolder,accountNumber:value.accountNumber,updatedAt:at},canConfigure:true,canReview:true});
 });}

 async function listFinanceStaff(user,selected=null){return withStorage(async()=>{
  const scope=await canonicalScope(user,selected);if(scope.error)return scope.error;
  if(!scope.manager)return json({error:'只有总部或租户老板可以管理财务权限'},403);
  const rows=await sql.prepare(`SELECT p.user_id,u.username,u.email,f.granted_at FROM portal_staff p JOIN portal_users u ON u.id=p.user_id
   LEFT JOIN portal_finance_staff f ON f.user_id=p.user_id AND f.tenant_id=p.tenant_id
   WHERE p.tenant_id=? AND p.role='employee' AND u.approved=1 ORDER BY u.username,u.id`).all(scope.tenantId);
  return json({tenantId:scope.tenantId,employees:rows.map(row=>({userId:row.user_id,username:row.username,email:row.email,finance:Boolean(row.granted_at),grantedAt:row.granted_at||null}))});
 });}

 async function setFinanceAccess(user,selected,data){return withStorage(async()=>{
  const scope=await canonicalScope(user,selected);if(scope.error)return scope.error;
  if(!scope.manager)return json({error:'只有总部或租户老板可以管理财务权限'},403);
  if(!idPattern.test(data?.userId||'')||typeof data?.enabled!=='boolean')return json({error:'财务权限资料无效'},400);
  const target=await sql.prepare(`SELECT u.id,u.email,p.tenant_id,p.role FROM portal_users u JOIN portal_staff p ON p.user_id=u.id
   WHERE u.id=? AND u.role='customer' AND u.approved=1`).get(data.userId);
  if(!target||target.role!=='employee'||target.tenant_id!==scope.tenantId)return json({error:'只可授权本租户的普通员工'},409);
  const at=currentTime().toISOString();await sql.exec('BEGIN IMMEDIATE');try{
   let changed;
   if(data.enabled)changed=await sql.prepare(`INSERT INTO portal_finance_staff(user_id,tenant_id,granted_by,granted_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET tenant_id=excluded.tenant_id,granted_by=excluded.granted_by,granted_at=excluded.granted_at`).run(target.id,scope.tenantId,scope.identity.id,at);
   else changed=await sql.prepare('DELETE FROM portal_finance_staff WHERE user_id=? AND tenant_id=?').run(target.id,scope.tenantId);
   if(changed.changes)await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),scope.tenantId,scope.identity.email,(data.enabled?'授予':'撤销')+'财务审核权限：'+target.id,at);
   await sql.exec('COMMIT');
  }catch(error){await sql.exec('ROLLBACK');throw error;}
  return json({tenantId:scope.tenantId,userId:target.id,finance:data.enabled});
 });}

 async function list(user,selected=null){return withStorage(async()=>{
  const scope=await canonicalScope(user,selected);if(scope.error)return scope.error;
  if(!scope.customer&&!scope.manager&&!scope.finance)return json({error:'没有银行转账记录权限'},403);
  const manager=scope.manager||scope.finance;
  const rows=await sql.prepare(`SELECT ${depositProjection('d.')},u.username FROM portal_bank_deposits d JOIN portal_users u ON u.id=d.user_id
   WHERE d.tenant_id=?${manager?'':' AND d.user_id=?'} ORDER BY d.created_at DESC,d.id DESC LIMIT 100`).all(...(manager?[scope.tenantId]:[scope.tenantId,scope.identity.id]));
  return json({tenantId:scope.tenantId,canReview:manager,deposits:rows.map(publicDeposit)});
 });}

 async function submit(user,selected,data){return withStorage(async()=>{
  const scope=await canonicalScope(user,selected);if(scope.error)return scope.error;
  if(!scope.customer)return json({error:'只有会员可以提交本人银行转账'},403);
  const normalized=normalizedSubmission(data,currentTime());if(!normalized)return json({error:'请检查金额、付款人、银行交易编号和转账时间'},400);
  const old=await sql.prepare(`SELECT ${depositProjection()} FROM portal_bank_deposits WHERE user_id=? AND request_key=?`).get(scope.identity.id,normalized.requestKey);
  if(old){const fingerprint=submissionFingerprint(normalized,{bank_name:old.recipient_bank_name,account_holder:old.recipient_account_holder,account_number:old.recipient_account_number,updated_at:old.bank_config_updated_at});return old.request_fingerprint===fingerprint?json({deposit:publicDeposit(old),duplicate:true}):json({error:'请求标识已用于其他银行转账'},409);}
  const account=await sql.prepare('SELECT * FROM portal_bank_accounts WHERE tenant_id=? AND enabled=1').get(scope.tenantId);
  if(!account)return json({error:'BANK_TRANSFER_NOT_OPEN'},409);
  if(account.updated_at!==normalized.bankConfigUpdatedAt)return json({error:'收款银行资料已更新，请重新核对后提交'},409);
  if(await rateLimit('bank-deposit:'+scope.identity.id,10))return json({error:'提交过于频繁，请稍后再试'},429);
  const id=randomUUID(),at=currentTime().toISOString(),fingerprint=submissionFingerprint(normalized,account);
  await sql.exec('BEGIN IMMEDIATE');try{
   await sql.prepare(`INSERT INTO portal_bank_deposits(id,tenant_id,user_id,request_key,request_fingerprint,amount_minor,currency,payer_name,transfer_reference,transferred_at,
    recipient_bank_name,recipient_account_holder,recipient_account_number,bank_config_updated_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'awaiting_review',?)`).run(id,scope.tenantId,scope.identity.id,normalized.requestKey,fingerprint,normalized.amountMinor,'MYR',normalized.payerName,normalized.transferReference,normalized.transferredAt,account.bank_name,account.account_holder,account.account_number,account.updated_at,at);
   await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),scope.tenantId,scope.identity.email,'提交银行转账充值待审核：'+id,at);
   await sql.exec('COMMIT');
  }catch(error){
   await sql.exec('ROLLBACK');
   const retry=await sql.prepare(`SELECT ${depositProjection()} FROM portal_bank_deposits WHERE user_id=? AND request_key=?`).get(scope.identity.id,normalized.requestKey);
   if(retry){const retryFingerprint=submissionFingerprint(normalized,{bank_name:retry.recipient_bank_name,account_holder:retry.recipient_account_holder,account_number:retry.recipient_account_number,updated_at:retry.bank_config_updated_at});return retry.request_fingerprint===retryFingerprint?json({deposit:publicDeposit(retry),duplicate:true}):json({error:'请求标识已用于其他银行转账'},409);}
   const collision=await sql.prepare('SELECT id FROM portal_bank_deposits WHERE tenant_id=? AND transfer_reference=?').get(scope.tenantId,normalized.transferReference);if(collision)return json({error:'该银行交易编号已提交，请勿重复登记'},409);throw error;
  }
  const created=await sql.prepare(`SELECT ${depositProjection()} FROM portal_bank_deposits WHERE id=?`).get(id);return json({deposit:publicDeposit(created),duplicate:false},201);
 });}

 async function uploadReceipt(user,selected,id,body,contentType){return withStorage(async()=>{
  const scope=await canonicalScope(user,selected);if(scope.error)return scope.error;
  if(!scope.customer)return json({error:'只有提交会员可以上传银行单据'},403);
  if(!idPattern.test(id||''))return json({error:'记录标识无效'},400);
  const mime=receiptMime(body,contentType);if(!mime)return json({error:'银行单据只接受有效 JPEG、PNG 或 WebP 图片，且不得超过 2 MiB'},415);
  const row=await sql.prepare('SELECT status,receipt_mime,receipt_size,receipt_sha256,receipt_uploaded_at FROM portal_bank_deposits WHERE id=? AND tenant_id=? AND user_id=?').get(id,scope.tenantId,scope.identity.id);
  if(!row)return json({error:'银行转账记录不存在'},404);
  if(row.status!=='awaiting_review')return json({error:'已审核记录不能更换银行单据'},409);
  const checksum=hash(body);if(row.receipt_sha256===checksum&&row.receipt_mime===mime&&Number(row.receipt_size)===body.length)return json({depositId:id,receipt:receiptMeta(row),duplicate:true});
  if(await rateLimit('bank-receipt:'+scope.identity.id,10))return json({error:'上传过于频繁，请稍后再试'},429);
  const at=currentTime().toISOString();await sql.exec('BEGIN IMMEDIATE');try{
   const changed=await sql.prepare(`UPDATE portal_bank_deposits SET receipt_mime=?,receipt_bytes=?,receipt_size=?,receipt_sha256=?,receipt_uploaded_at=?
    WHERE id=? AND tenant_id=? AND user_id=? AND status='awaiting_review'`).run(mime,body,body.length,checksum,at,id,scope.tenantId,scope.identity.id);
   if(!changed.changes)throw Error('BANK_RECEIPT_STATE_CHANGED');
   await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),scope.tenantId,scope.identity.email,(row.receipt_sha256?'更换':'上传')+'银行转账单据：'+id,at);
   await sql.exec('COMMIT');
  }catch(error){await sql.exec('ROLLBACK');if(error.message==='BANK_RECEIPT_STATE_CHANGED')return json({error:'记录状态已变化，请刷新'},409);throw error;}
  return json({depositId:id,receipt:{present:true,mimeType:mime,size:body.length,sha256:checksum,uploadedAt:at},duplicate:false});
 });}

 async function readReceipt(user,selected,id){return withStorage(async()=>{
  const scope=await canonicalScope(user,selected);if(scope.error)return scope.error;
  if(!scope.customer&&!scope.manager&&!scope.finance)return json({error:'没有查看银行单据权限'},403);
  if(!idPattern.test(id||''))return json({error:'记录标识无效'},400);
  const row=await sql.prepare(`SELECT receipt_mime,receipt_bytes,receipt_size,receipt_sha256 FROM portal_bank_deposits WHERE id=? AND tenant_id=?${scope.customer?' AND user_id=?':''}`).get(...(scope.customer?[id,scope.tenantId,scope.identity.id]:[id,scope.tenantId]));
  if(!row||!row.receipt_bytes)return json({error:'银行单据不存在'},404);
  const bytes=Buffer.from(row.receipt_bytes),extension=receiptExtensions[row.receipt_mime];
  if(!extension||bytes.length!==Number(row.receipt_size)||hash(bytes)!==row.receipt_sha256||!receiptMime(bytes,row.receipt_mime))return json({error:'银行单据资料无法验证'},503);
  return new Response(bytes,{headers:{'Content-Type':row.receipt_mime,'Content-Length':String(bytes.length),'Content-Disposition':`inline; filename="bank-receipt.${extension}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'}});
 });}

 async function review(user,selected,id,data){return withStorage(async()=>{
  const scope=await canonicalScope(user,selected);if(scope.error)return scope.error;
  if(!scope.manager&&!scope.finance)return json({error:'没有财务审核权限'},403);
  if(!idPattern.test(id||'')||!['approve','reject'].includes(data?.decision)||!requestKeyPattern.test(data?.reviewKey||''))return json({error:'审核资料无效'},400);
  const expectedReceipt=data.decision==='approve'&&typeof data?.receiptSha256==='string'&&/^[a-f0-9]{64}$/.test(data.receiptSha256)?data.receiptSha256:null;
  const reason=data.decision==='reject'?text(data?.reason,3,300):data?.reason?text(data.reason,1,300):'';
  if(reason===null||data.decision==='reject'&&!reason||data.decision==='approve'&&data?.bankVerified!==true)return json({error:data?.decision==='approve'?'必须明确确认银行已实际到账':'拒绝时必须填写原因'},400);
  const fingerprint=digestObject({decision:data.decision,bankVerified:data.decision==='approve',receiptSha256:expectedReceipt,reason:reason||''}),at=currentTime().toISOString();
  await sql.exec('BEGIN IMMEDIATE');try{
   const row=await sql.prepare(`SELECT ${depositProjection()} FROM portal_bank_deposits WHERE id=? AND tenant_id=?`).get(id,scope.tenantId);
   if(!row){await sql.exec('ROLLBACK');return json({error:'银行转账记录不存在'},404);}
   if(row.status!=='awaiting_review'){
    const duplicate=row.reviewed_by===scope.identity.id&&row.review_request_key===data.reviewKey&&row.review_fingerprint===fingerprint;
    await sql.exec('ROLLBACK');return duplicate?json({deposit:publicDeposit(row),duplicate:true}):json({error:'该记录已经审核，不能重复改变结果'},409);
   }
   if(data.decision==='approve'&&!row.receipt_sha256){await sql.exec('ROLLBACK');return json({error:'BANK_RECEIPT_REQUIRED'},409);}
   if(data.decision==='approve'&&!expectedReceipt){await sql.exec('ROLLBACK');return json({error:'必须提供刚才核对的银行单据指纹'},400);}
   if(data.decision==='approve'&&row.receipt_sha256!==expectedReceipt){await sql.exec('ROLLBACK');return json({error:'银行单据已变化，请重新打开并核对'},409);}
   if(data.decision==='approve'){
    const member=await sql.prepare(`SELECT u.id,u.approved,COALESCE(m.tenant_id,'main') AS tenant_id FROM portal_users u LEFT JOIN members m ON m.email=u.email
     LEFT JOIN portal_staff p ON p.user_id=u.id WHERE u.id=? AND u.role='customer' AND p.user_id IS NULL`).get(row.user_id);
    if(!member||!member.approved||member.tenant_id!==scope.tenantId){await sql.exec('ROLLBACK');return json({error:'会员归属已变化，不能入账'},409);}
    const claimed=await sql.prepare(`UPDATE portal_bank_deposits SET status='approved',review_request_key=?,review_fingerprint=?,review_decision='approve',review_reason=?,reviewed_by=?,reviewed_at=?,wallet_order_id=?
     WHERE id=? AND tenant_id=? AND status='awaiting_review' AND receipt_sha256=?`).run(data.reviewKey,fingerprint,reason||null,scope.identity.id,at,id,id,scope.tenantId,expectedReceipt);
    if(!claimed.changes){
     const latest=await sql.prepare(`SELECT ${depositProjection()} FROM portal_bank_deposits WHERE id=? AND tenant_id=?`).get(id,scope.tenantId),duplicate=latest?.reviewed_by===scope.identity.id&&latest.review_request_key===data.reviewKey&&latest.review_fingerprint===fingerprint;
     await sql.exec('ROLLBACK');return duplicate?json({deposit:publicDeposit(latest),duplicate:true}):json({error:'记录或银行单据已变化，请刷新'},409);
    }
    await sql.prepare(`INSERT INTO portal_payment_orders(id,tenant_id,user_id,request_key,merchant_id,environment,amount_minor,currency,trade_no,settlement_status,review_required,created_at,verified_at,credited_at,create_outcome,trade_code,provider)
     VALUES (?,?,?,?,?,'production',?,'MYR',?,'credited',0,?,?,?,'created','bank_transfer','bank_transfer')`).run(id,scope.tenantId,row.user_id,'bank_'+id,'manual_bank',row.amount_minor,id,row.created_at,at,at);
    await sql.prepare(`INSERT INTO portal_wallet_journal(id,order_id,tenant_id,user_id,environment,currency,member_minor,clearing_minor,created_at)
     VALUES (?,?,?,?,?,'MYR',?,?,?)`).run(randomUUID(),id,scope.tenantId,row.user_id,'production',row.amount_minor,-row.amount_minor,at);
    await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),scope.tenantId,scope.identity.email,'核对银行到账并单次入账：'+id,at);
   }else{
    const changed=await sql.prepare(`UPDATE portal_bank_deposits SET status='rejected',review_request_key=?,review_fingerprint=?,review_decision='reject',review_reason=?,reviewed_by=?,reviewed_at=?
     WHERE id=? AND tenant_id=? AND status='awaiting_review'`).run(data.reviewKey,fingerprint,reason,scope.identity.id,at,id,scope.tenantId);
    if(!changed.changes){
     const latest=await sql.prepare(`SELECT ${depositProjection()} FROM portal_bank_deposits WHERE id=? AND tenant_id=?`).get(id,scope.tenantId),duplicate=latest?.reviewed_by===scope.identity.id&&latest.review_request_key===data.reviewKey&&latest.review_fingerprint===fingerprint;
     await sql.exec('ROLLBACK');return duplicate?json({deposit:publicDeposit(latest),duplicate:true}):json({error:'记录状态已变化，请刷新'},409);
    }
    await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),scope.tenantId,scope.identity.email,'拒绝银行转账充值：'+id,at);
   }
   await sql.exec('COMMIT');
  }catch(error){
   await sql.exec('ROLLBACK');
   const keyOwner=await sql.prepare('SELECT id FROM portal_bank_deposits WHERE reviewed_by=? AND review_request_key=?').get(scope.identity.id,data.reviewKey);
   if(keyOwner)return json({error:'审核请求标识已用于其他记录'},409);
   throw error;
  }
  const updated=await sql.prepare(`SELECT ${depositProjection('d.')},u.username FROM portal_bank_deposits d JOIN portal_users u ON u.id=d.user_id WHERE d.id=?`).get(id);
  return json({deposit:publicDeposit(updated),duplicate:false});
 });}

 async function getTodayMetrics(user,selected=null){return withStorage(async()=>{
  const scope=await canonicalScope(user,selected);if(scope.error)return scope.error;
  if(!scope.manager&&!scope.finance)return json({error:'没有财务统计权限'},403);
  const instant=currentTime(),localDate=new Date(instant.getTime()+8*3600000).toISOString().slice(0,10);
  const from=new Date(Date.parse(localDate+'T00:00:00.000Z')-8*3600000).toISOString(),to=new Date(Date.parse(from)+86400000).toISOString();
  const bankSubmitted=await sql.prepare(`SELECT count(*) AS count,CAST(COALESCE(SUM(amount_minor),0) AS TEXT) AS amount FROM portal_bank_deposits
   WHERE tenant_id=? AND created_at>=? AND created_at<?`).get(scope.tenantId,from,to);
  const vpaySubmitted=await sql.prepare(`SELECT count(*) AS count,CAST(COALESCE(SUM(amount_minor),0) AS TEXT) AS amount FROM portal_payment_orders
   WHERE tenant_id=? AND environment='production' AND provider='vpay' AND created_at>=? AND created_at<?`).get(scope.tenantId,from,to);
  const gspaySubmitted=await sql.prepare(`SELECT count(*) AS count,CAST(COALESCE(SUM(amount_minor),0) AS TEXT) AS amount FROM portal_payment_orders
   WHERE tenant_id=? AND environment='production' AND provider='gspay_myr' AND created_at>=? AND created_at<?`).get(scope.tenantId,from,to);
  const unknownSubmitted=await sql.prepare(`SELECT count(*) AS count,CAST(COALESCE(SUM(amount_minor),0) AS TEXT) AS amount FROM portal_payment_orders
   WHERE tenant_id=? AND environment='production' AND provider='unknown' AND created_at>=? AND created_at<?`).get(scope.tenantId,from,to);
  const pending=await sql.prepare(`SELECT count(*) AS count,CAST(COALESCE(SUM(amount_minor),0) AS TEXT) AS amount FROM portal_bank_deposits
   WHERE tenant_id=? AND status='awaiting_review'`).get(scope.tenantId);
  const bankCredited=await sql.prepare(`SELECT count(*) AS count,CAST(COALESCE(SUM(j.member_minor),0) AS TEXT) AS amount FROM portal_wallet_journal j
   JOIN portal_payment_orders o ON o.id=j.order_id WHERE j.tenant_id=? AND j.environment='production' AND o.provider='bank_transfer' AND j.created_at>=? AND j.created_at<?`).get(scope.tenantId,from,to);
  const vpayCredited=await sql.prepare(`SELECT count(*) AS count,CAST(COALESCE(SUM(j.member_minor),0) AS TEXT) AS amount FROM portal_wallet_journal j
   JOIN portal_payment_orders o ON o.id=j.order_id WHERE j.tenant_id=? AND j.environment='production' AND o.provider='vpay' AND j.created_at>=? AND j.created_at<?`).get(scope.tenantId,from,to);
  const gspayCredited=await sql.prepare(`SELECT count(*) AS count,CAST(COALESCE(SUM(j.member_minor),0) AS TEXT) AS amount FROM portal_wallet_journal j
   JOIN portal_payment_orders o ON o.id=j.order_id WHERE j.tenant_id=? AND j.environment='production' AND o.provider='gspay_myr' AND j.created_at>=? AND j.created_at<?`).get(scope.tenantId,from,to);
  const unknownCredited=await sql.prepare(`SELECT count(*) AS count,CAST(COALESCE(SUM(j.member_minor),0) AS TEXT) AS amount FROM portal_wallet_journal j
   JOIN portal_payment_orders o ON o.id=j.order_id WHERE j.tenant_id=? AND j.environment='production' AND o.provider='unknown' AND j.created_at>=? AND j.created_at<?`).get(scope.tenantId,from,to);
  const bankAccount=await sql.prepare('SELECT enabled FROM portal_bank_accounts WHERE tenant_id=?').get(scope.tenantId);
  const registrations=await sql.prepare(`SELECT count(*) AS count FROM portal_users u LEFT JOIN members m ON m.email=u.email LEFT JOIN portal_staff p ON p.user_id=u.id
   WHERE u.role='customer' AND p.user_id IS NULL AND COALESCE(m.tenant_id,'main')=? AND u.created_at>=? AND u.created_at<?`).get(scope.tenantId,from,to);
  const submittedCount=Number(bankSubmitted.count)+Number(vpaySubmitted.count)+Number(gspaySubmitted.count)+Number(unknownSubmitted.count),submittedAmount=(BigInt(bankSubmitted.amount)+BigInt(vpaySubmitted.amount)+BigInt(gspaySubmitted.amount)+BigInt(unknownSubmitted.amount)).toString();
  const creditedCount=Number(bankCredited.count)+Number(vpayCredited.count)+Number(gspayCredited.count)+Number(unknownCredited.count),creditedAmount=(BigInt(bankCredited.amount)+BigInt(vpayCredited.amount)+BigInt(gspayCredited.amount)+BigInt(unknownCredited.amount)).toString();
  const vpayEnabled=vpayProductionReady(env);
  return json({tenantId:scope.tenantId,date:localDate,timeZone:'Asia/Kuching',range:{from,to},
   deposits:{definition:'submitted orders or bank-transfer claims created during the local day; credited totals count wallet journal entries created during the local day',
    submitted:{count:submittedCount,amountMinor:submittedAmount},credited:{count:creditedCount,amountMinor:creditedAmount},channels:{
     vpay:{enabled:vpayEnabled,count:Number(vpaySubmitted.count),amountMinor:String(vpaySubmitted.amount),submitted:{count:Number(vpaySubmitted.count),amountMinor:String(vpaySubmitted.amount)},credited:{count:Number(vpayCredited.count),amountMinor:String(vpayCredited.amount)}},
     gspay_myr:{enabled:false,count:Number(gspaySubmitted.count),amountMinor:String(gspaySubmitted.amount),submitted:{count:Number(gspaySubmitted.count),amountMinor:String(gspaySubmitted.amount)},credited:{count:Number(gspayCredited.count),amountMinor:String(gspayCredited.amount)}},
     unknown:{enabled:false,count:Number(unknownSubmitted.count),amountMinor:String(unknownSubmitted.amount),submitted:{count:Number(unknownSubmitted.count),amountMinor:String(unknownSubmitted.amount)},credited:{count:Number(unknownCredited.count),amountMinor:String(unknownCredited.amount)}},
     bank_transfer:{enabled:Boolean(bankAccount?.enabled),count:Number(bankSubmitted.count),amountMinor:String(bankSubmitted.amount),submitted:{count:Number(bankSubmitted.count),amountMinor:String(bankSubmitted.amount)},credited:{count:Number(bankCredited.count),amountMinor:String(bankCredited.amount)}}}},
   bankPendingReview:{count:Number(pending.count),amountMinor:String(pending.amount)},
   withdrawals:{enabled:false,count:0,amountMinor:'0'},newRegistrations:Number(registrations.count)});
 });}

 return {getConfiguration,saveConfiguration,listFinanceStaff,setFinanceAccess,list,submit,uploadReceipt,readReceipt,review,getTodayMetrics};
}
