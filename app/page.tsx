import { getChatGPTUser,chatGPTSignInPath } from './chatgpt-auth';
import Portal from './portal';
export const dynamic='force-dynamic';
export default async function Page(){const user=await getChatGPTUser();if(!user)return <main className="welcome"><div className="brandmark">S<span>·</span></div><p className="eyebrow">SERVICE PORTAL</p><h1>一处连接，<br/>服务有序。</h1><p>公告、服务申请与处理进度，集中在一个清晰的空间。</p><a className="primary" target="_top" href={chatGPTSignInPath('/')}>安全登录 →</a><small>此版本使用 ChatGPT 托管登录。</small></main>;return <Portal mode="customer"/>;}
