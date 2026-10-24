import { getChatGPTUser } from '../../chatgpt-auth';
import { getDb } from '../../../db';
import { notices,tickets,audit,brands,members,portalUsers,portalSessions,portalStaff } from '../../../db/schema';
import { eq,desc,and,gte,count } from 'drizzle-orm';
import { isOwner } from '../../../lib/access';
export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const defaultBrand={id:'main',name:'MASTER7',tagline:'欢迎来到服务中心',color:'#2165e8',logo:'',language:'zh-CN' as const,supportUrl:''};
async function context(user:{email:string;role?:string;tenantId?:string|null;finance?:boolean},req?:Request){
 const db=getDb(),headOffice=isOwner(user.email),employee=user.role==='employee',tenantOwner=user.role==='tenant_owner',owner=headOffice||employee||tenantOwner;
 const [member]=await db.select().from(members).where(eq(members.email,user.email.toLowerCase()));
 const selected=req?new URL(req.url).searchParams.get('tenant'):null;
 if((employee||tenantOwner)&&(!user.tenantId||(selected&&selected!==user.tenantId)))throw new Error('TENANT_FORBIDDEN');
 const tenantId=headOffice?(selected||'main'):((employee||tenantOwner)?user.tenantId!:(member?.tenantId||'main'));
 const [brand]=await db.select().from(brands).where(eq(brands.id,tenantId));
 if(!brand&&tenantId!=='main')throw new Error('TENANT_NOT_FOUND');
 return {db,owner,headOffice,employee,tenantId,brand:brand||defaultBrand};
}
export async function GET(req?:Request){
 const user=await getChatGPTUser();if(!user)return json({error:'请先登录'},401);
 const serviceOnly=process.env.NODE_ENV!=='test'&&Boolean(process.env.RENDER_EXTERNAL_URL);
 try{const {owner,headOffice,employee,db,tenantId,brand}=await context(user,req);const tenantList=headOffice?await db.select().from(brands):[];
 return json({serviceOnly,user:{name:user.displayName,email:user.email,owner,role:user.role||'customer',finance:Boolean(user.finance)},tenantId,brand,tenants:headOffice?[...(tenantList.some(b=>b.id==='main')?[]:[defaultBrand]),...tenantList]:[],members:owner&&!employee?await db.select().from(members).where(eq(members.tenantId,tenantId)):[],notices:await db.select().from(notices).where(and(eq(notices.tenantId,tenantId),owner&&!employee?undefined:eq(notices.published,true))).orderBy(desc(notices.createdAt)).limit(100),tickets:await db.select().from(tickets).where(and(eq(tickets.tenantId,tenantId),owner?undefined:eq(tickets.userId,user.userId))).orderBy(desc(tickets.createdAt)).limit(200),audit:owner&&!employee?await db.select().from(audit).where(eq(audit.tenantId,tenantId)).orderBy(desc(audit.createdAt)).limit(50):[]});
 }catch(e){if(e instanceof Error&&e.message==='TENANT_FORBIDDEN')return json({error:'无权访问其他租户'},403);if(e instanceof Error&&e.message==='TENANT_NOT_FOUND')return json({error:'品牌不存在'},404);return json({error:'资料暂时无法读取，请稍后重试。'},503);}
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
  const {owner,headOffice,employee,db,tenantId,brand}=await context(user,req);
  if(data.action==='create-ticket'){
   const subject=field(data.subject,120),body=field(data.body,4000);
   const [total]=await db.select({n:count()}).from(tickets).where(and(eq(tickets.tenantId,tenantId),eq(tickets.userId,user.userId),gte(tickets.createdAt,new Date(Date.now()-86400000).toISOString())));
   if(total.n>=20)return json({error:'今日申请已达上限，请明天再试'},429);
   await db.insert(tickets).values({id,tenantId,userId:user.userId,name:user.displayName,subject,body,createdAt:now});return json({ok:true,id},201);
  }
  if(!owner)return json({error:'仅老板可执行此操作'},403);
  if(employee&&data.action!=='update-ticket')return json({error:'员工仅可处理本租户服务申请'},403);
  if(!headOffice&&['create-brand','assign-member'].includes(data.action))return json({error:'仅总部可分配租户与成员'},403);
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
   const language=Object.hasOwn(data,'language')?data.language:(brand.language??defaultBrand.language),supportUrl=Object.hasOwn(data,'supportUrl')?data.supportUrl:(brand.supportUrl??defaultBrand.supportUrl);
   if(typeof language!=='string'||!['zh-CN','en','ms'].includes(language))return json({error:'请选择支持的平台语言'},400);
   if(typeof supportUrl!=='string'||supportUrl.length>1000)return json({error:'客服地址无效'},400);
   if(supportUrl){try{const u=new URL(supportUrl);if(u.protocol!=='https:'||u.username||u.password)throw Error();}catch{return json({error:'客服仅支持不含账号密码的 HTTPS 地址'},400);}}
   const settings={name,tagline,color:data.color,logo:data.logo,language:language as 'zh-CN'|'en'|'ms',supportUrl};
   await db.batch([db.insert(brands).values({...settings,id:tenantId,createdAt:now}).onConflictDoUpdate({target:brands.id,set:settings}),db.insert(audit).values({id:crypto.randomUUID(),tenantId,actor:user.email,action:'更新品牌设置',createdAt:now})]);
  }else if(data.action==='assign-member'){
   const email=field(data.email,254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({error:'邮箱格式无效'},400);
   const [existing]=await db.select().from(members).where(eq(members.email,email));
   if(existing&&existing.tenantId!==tenantId){
    // Approval binds an unassigned account to main. Headquarters may move
    // that ordinary customer once to an explicit brand; later cross-brand
    // transfers still require a separate reviewed migration.
    if(existing.tenantId!=='main'||tenantId==='main')return json({error:'该账号已归属其他品牌，请先核对归属'},409);
    const [account]=await db.select({id:portalUsers.id,role:portalUsers.role}).from(portalUsers).where(eq(portalUsers.email,email));
    const [staff]=account?await db.select({userId:portalStaff.userId}).from(portalStaff).where(eq(portalStaff.userId,account.id)):[];
    if(!account||account.role!=='customer'||staff)return json({error:'只有普通会员可以从主空间分配到品牌'},409);
    await db.batch([
     // This no-op identity write serializes the membership move with wallet
     // settlement and staff promotion, which lock the same account row.
     db.update(portalUsers).set({id:account.id}).where(and(eq(portalUsers.id,account.id),eq(portalUsers.role,'customer'))),
     db.update(members).set({tenantId}).where(and(eq(members.email,email),eq(members.tenantId,'main'))),
     db.delete(portalSessions).where(eq(portalSessions.userId,account.id)),
     db.insert(audit).values({id:crypto.randomUUID(),tenantId,actor:user.email,action:'从主空间分配品牌成员：'+email,createdAt:now}),
    ]);
    const [assigned]=await db.select().from(members).where(eq(members.email,email));
    const [assignedStaff]=await db.select({userId:portalStaff.userId}).from(portalStaff).where(eq(portalStaff.userId,account.id));
    if(!assigned||assigned.tenantId!==tenantId||assignedStaff)return json({error:'账号归属已变化，请重新核对'},409);
   }else await db.batch([db.insert(members).values({email,tenantId,createdAt:now}).onConflictDoNothing(),db.insert(audit).values({id:crypto.randomUUID(),tenantId,actor:user.email,action:'分配品牌成员：'+email,createdAt:now})]);
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
 }catch(e){if(e instanceof Error&&e.message==='TENANT_FORBIDDEN')return json({error:'无权访问其他租户'},403);if(e instanceof Error&&e.message==='TENANT_NOT_FOUND')return json({error:'品牌不存在'},404);if(e instanceof Error&&e.message==='字段为空或超过长度限制')return json({error:e.message},400);return json({error:'保存失败，请稍后重试。'},503);}
}
