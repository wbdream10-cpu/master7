import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'Service Portal · 服务中心',description:'公告、服务申请及管理中心',robots:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-Hans"><body>{children}</body></html>}
