import { requireChatGPTUser } from '../chatgpt-auth';
import { isOwner } from '../../lib/access';
import Portal from '../portal';
export const dynamic='force-dynamic';
export default async function Admin(){const user=await requireChatGPTUser('/admin');if(!isOwner(user.email))return <main className="welcome"><h1>无管理权限</h1><p>这个账号不能访问老板后台。</p><a className="primary" href="/">返回顾客前台</a></main>;return <Portal mode="admin"/>;}
