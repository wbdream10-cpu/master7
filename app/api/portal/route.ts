import { getChatGPTUser } from '../../chatgpt-auth';
import { getDb } from '../../../db';
import { notices,tickets,audit,brands,members } from '../../../db/schema';
import { eq,desc,and,gte,count } from 'drizzle-orm';
import { isOwner } from '../../../lib/access';
export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const defaultBrand={id:'main',name:'Service Portal',tagline:'欢迎来到服务中心',color:'#2165e8',logo:''};
async function context(user:{email:string},req?:Request){
 const db=getDb(),owner=isOwner(user.email);
 const [member]=await db.select().from(members).where(eq(members.email,user.email.toLowerCase()));
 const selected=req?new URL(req.url).searchParams.get('tenant'):null;
 const tenantId=owner?(selected||'main'):(member?.tenantId||'main');
 const [brand]=await db.select().from(brands).where(eq(brands.id,tenantId));
 if(!brand&&tenantId!=='main')throw new Error('TENANT_NOT_FOUND');
 return {db,owner,tenantId,brand:brand||defaultBrand};
}
export async function GET(req?:Request){
 const user=await getChatGPTUser();if(!user)return json({error:'请先登录'},401);
 try{const {owner,db,tenantId,brand}=await context(user,req);const tenantList=owner?await db.select().from(brands):[];
 return json({user:{name:user.displayName,email:user.email,owner},tenantId,brand,tenants:owner?[...(tenantList.some(b=>b.id==='main')?[]:[defaultBrand]),...tenantList]:[],members:owner?await db.select().from(members).where(eq(members.tenantId,tenantId)):[],notices:await db.select().from(notices).where(and(eq(notices.tenantId,tenantId),owner?undefined:eq(notices.published,true))).orderBy(desc(notices.createdAt)).limit(100),tickets:await db.select().from(tickets).where(and(eq(tickets.tenantId,tenantId),owner?undefined:eq(tickets.userId,user.userId))).orderBy(desc(tickets.createdAt)).limit(200),audit:owner?await db.select().from(audit).where(eq(audit.tenantId,tenantId)).orderBy(desc(audit.createdAt)).limit(50):[]});
 }catch(e){if(e instanceof Error&&e.message==='TENANT_NOT_FOUND')return json({error:'品牌不存在'},404);return json({error:'资料暂时无法读取，请稍后重试。'},503);}
}

function field(v:unknown,max:number){if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error('字段为空或超过长度限制');return v.trim();}
export async function POST(req:Request){
 const user=await getChatGPTUser();if(!user)return json({error:'请先登录'},401);
 if(req.headers.get('origin')!==new URL(req.url).origin||req.headers.get('x-portal-request')!=='1')return json({error:'请求来源不受信任'},403);
 if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'请求格式错误'},415);
 const raw=await req.text();if(raw.length>16000)return json({error:'内容过长'},413);
 let data:any;try{data=JSON.parse(raw)}catch{return json({error:'请求格式错误'},400)}
 if(!data||typeof data!=='object')return json({error:'请求格式错误'},400);
 const now=new Date().toISOString(),id=crypto.randomUUID();
 try{
  const {owner,db,tenantId,brand}=await context(user,req);
  if(data.action==='create-ticket'){
   const subject=field(data.subject,120),body=field(data.body,4000);
   const [total]=await db.select({n:count()}).from(tickets).where(and(eq(tickets.tenantId,tenantId),eq(tickets.userId,user.userId),gte(tickets.createdAt,new Date(Date.now()-86400000).toISOString())));
   if(total.n>=20)return json({error:'今日申请已达上限，请明天再试'},429);
   await db.insert(tickets).values({id,tenantId,userId:user.userId,name:user.displayName,subject,body,createdAt:now});return json({ok:true,id},201);
  }
  if(!owner)return json({error:'仅老板可执行此操作'},403);
  if(data.action==='create-brand'){
   const name=field(data.name,60);await db.batch([db.insert(brands).values({id,name,createdAt:now}),db.insert(audit).values({id:crypto.randomUUID(),tenantId,actor:user.email,action:'创建品牌：'+name,createdAt:now})]);return json({ok:true,tenantId:id});
  }else if(data.action==='save-logo'){
   if(typeof data.logo!=='string'||data.logo.length>1000)return json({error:'Logo 地址无效'},400);
   if(data.logo){try{const u=new URL(data.logo);if(u.protocol!=='https:'||u.username||u.password)throw Error();}catch{return json({error:'Logo 仅支持 HTTPS 图片地址'},400);}}
   await db.batch([db.insert(brands).values({...brand,id:tenantId,logo:data.logo,createdAt:now}).onConflictDoUpdate({target:brands.id,set:{logo:data.logo}}),db.insert(audit).values({id:crypto.randomUUID(),tenantId,actor:user.email,action:'更新 Logo',createdAt:now})]);
  }else if(data.action==='save-brand'){
   const name=field(data.name,60),tagline=field(data.tagline,150);
   if(typeof data.color!=='string'||!/^#[0-9a-fA-F]{6}$/.test(data.color))return json({error:'请输入有效的六位主题色'},400);
   if(typeof data.logo!=='string'||data.logo.length>1000)return json({error:'Logo 地址无效'},400);
   if(data.logo){try{const u=new URL(data.logo);if(u.protocol!=='https:'||u.username||u.password)throw Error();}catch{return json({error:'Logo 仅支持 HTTPS 图片地址'},400);}}
   await db.batch([db.insert(brands).values({id:tenantId,name,tagline,color:data.color,logo:data.logo,createdAt:now}).onConflictDoUpdate({target:brands.id,set:{name,tagline,color:data.color,logo:data.logo}}),db.insert(audit).values({id:crypto.randomUUID(),tenantId,actor:user.email,action:'更新品牌设置',createdAt:now})]);
  }else if(data.action==='assign-member'){
   const email=field(data.email,254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({error:'邮箱格式无效'},400);
   const [existing]=await db.select().from(members).where(eq(members.email,email));
   if(existing&&existing.tenantId!==tenantId)return json({error:'该账号已归属其他品牌，请先核对归属'},409);
   await db.batch([db.insert(members).values({email,tenantId,createdAt:now}).onConflictDoNothing(),db.insert(audit).values({id:crypto.randomUUID(),tenantId,actor:user.email,action:'分配品牌成员：'+email,createdAt:now})]);
  }else if(data.action==='save-notice'){
   const title=field(data.title,120),body=field(data.body,6000),published=data.published===true;
   await db.batch([db.insert(notices).values({id,tenantId,title,body,published,createdAt:now}),db.insert(audit).values({id:crypto.randomUUID(),tenantId,actor:user.email,action:published?'发布公告：'+title:'保存公告草稿：'+title,createdAt:now})]);
  }else if(data.action==='edit-notice'){
   const noticeId=field(data.id,60),title=field(data.title,120),body=field(data.body,6000);
   const [item]=await db.select().from(notices).where(and(eq(notices.id,noticeId),eq(notices.tenantId,tenantId)));if(!item)return json({error:'公告不存在'},404);
   await db.batch([db.update(notices).set({title,body}).where(and(eq(notices.id,noticeId),eq(notices.tenantId,tenantId))),db.insert(audit).values({id:crypto.randomUUID(),tenantId,actor:user.email,action:'编辑公告：'+title,createdAt:now})]);
  }else if(data.action==='toggle-notice'){
   const noticeId=field(data.id,60),published=data.published===true;
   const [item]=await db.select().from(notices).where(and(eq(notices.id,noticeId),eq(notices.tenantId,tenantId)));if(!item)return json({error:'公告不存在'},404);
   await db.batch([db.update(notices).set({published}).where(and(eq(notices.id,noticeId),eq(notices.tenantId,tenantId))),db.insert(audit).values({id:crypto.randomUUID(),tenantId,actor:user.email,action:(published?'发布':'撤下')+'公告：'+item.title,createdAt:now})]);
  }else if(data.action==='update-ticket'){
   const ticketId=field(data.id,60);if(!['待处理','处理中','已完成'].includes(data.status))return json({error:'状态无效'},400);
   if(typeof data.reply!=='string'||data.reply.length>4000)return json({error:'回复过长'},400);
   const [item]=await db.select().from(tickets).where(and(eq(tickets.id,ticketId),eq(tickets.tenantId,tenantId)));if(!item)return json({error:'申请不存在'},404);
   await db.batch([db.update(tickets).set({status:data.status,reply:data.reply.trim()}).where(and(eq(tickets.id,ticketId),eq(tickets.tenantId,tenantId))),db.insert(audit).values({id:crypto.randomUUID(),tenantId,actor:user.email,action:'更新服务申请 '+ticketId.slice(0,8)+'：'+data.status,createdAt:now})]);
  }else return json({error:'操作不存在'},400);
  return json({ok:true});
 }catch(e){if(e instanceof Error&&e.message==='TENANT_NOT_FOUND')return json({error:'品牌不存在'},404);if(e instanceof Error&&e.message==='字段为空或超过长度限制')return json({error:e.message},400);return json({error:'保存失败，请稍后重试。'},503);}
}
