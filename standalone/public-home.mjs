// Public, service-only entry page. No protected data or business metrics are rendered here.
export function publicHomeBody() {
 return `<style>
.m7-home{max-width:1160px;margin:0 auto;padding:0 24px 48px;position:relative}
.m7-home a:focus-visible{outline:3px solid #f0c66a;outline-offset:4px}
.m7-home-nav{height:auto;position:static;top:auto;z-index:auto;background:transparent;backdrop-filter:none;display:flex;justify-content:space-between;align-items:center;gap:24px;padding:23px 0;border-bottom:1px solid rgba(131,173,235,.2)}
.m7-home-brand{display:flex;gap:13px;align-items:center;color:#fff;font-size:22px;font-weight:850;letter-spacing:.1em}
.m7-home-brand:hover{text-decoration:none}
.m7-home-brand img{height:54px;width:54px;object-fit:contain}
.m7-home-brand small{display:block;color:#a7bbdb;font-size:11px;letter-spacing:.18em;font-weight:650;margin-top:5px}
.m7-home-links{display:flex;align-items:center;gap:23px;flex-wrap:wrap}
.m7-home-links a{font-size:14px;font-weight:650;color:#dae9ff}
.m7-home-links .m7-home-signin{border:1px solid rgba(106,170,255,.45);padding:11px 19px;border-radius:12px;background:rgba(17,67,122,.25)}
.m7-home-hero{padding:92px 0 72px;max-width:850px}
.m7-home-eyebrow{color:#edc473!important;text-transform:uppercase;letter-spacing:.19em;font-size:12px!important;font-weight:800}
.m7-home h1{font-size:clamp(40px,7vw,76px);line-height:1.12;letter-spacing:-.06em;margin:23px 0 25px}
.m7-home h1 span{display:block;background:linear-gradient(100deg,#9bd5ff,#f0c779);background-clip:text;-webkit-background-clip:text;color:transparent}
.m7-home-intro{font-size:clamp(16px,2.1vw,19px);line-height:1.9;color:#c3d3ea;max-width:630px}
.m7-home-actions{display:flex;gap:14px;flex-wrap:wrap;margin-top:33px}
.m7-home-actions a{min-width:164px;text-align:center}
.m7-home-section{padding:36px 0 55px}
.m7-home-section h2{font-size:clamp(25px,4vw,34px);letter-spacing:-.03em}
.m7-home-caption{color:#a8bcda;line-height:1.8}
.m7-home-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:19px;margin-top:26px}
.m7-home-card{padding:30px 27px;min-height:220px;border:1px solid rgba(97,157,229,.27);border-radius:20px;background:linear-gradient(145deg,rgba(16,39,83,.85),rgba(7,18,40,.85));box-shadow:0 20px 44px rgba(0,0,0,.15)}
.m7-home-card .m7-home-num{font-size:12px;color:#f0c779;font-weight:800;letter-spacing:.15em}
.m7-home-card h3{font-size:20px;margin:25px 0 13px}
.m7-home-card p{color:#aebed6;font-size:14px;line-height:1.8;margin:0}
.m7-home-help{display:flex;align-items:center;justify-content:space-between;gap:25px;padding:30px 34px;border-radius:20px;border:1px solid rgba(97,157,229,.3);background:rgba(8,28,61,.85)}
.m7-home-help h2{margin-bottom:8px}
.m7-home-help p{color:#b7c8df;line-height:1.7;margin:0}
.m7-home-footer{margin-top:50px;padding-top:25px;border-top:1px solid rgba(131,173,235,.2);color:#93a6c4;font-size:13px}
@media(max-width:760px){.m7-home{padding:0 18px 32px}.m7-home-nav{align-items:flex-start;flex-direction:column;gap:16px}.m7-home-links{gap:16px}.m7-home-hero{padding:66px 0 38px}.m7-home-grid{grid-template-columns:1fr}.m7-home-card{min-height:unset;padding:23px}.m7-home-help{display:block;padding:25px}.m7-home-help .secondary{margin-top:19px}.m7-home-actions a{flex:1 1 180px}}
</style>
<div class="m7-home">
<header class="m7-home-nav">
<a class="m7-home-brand" href="/" aria-label="MASTER7 客户服务门户首页"><img src="/brand/master7-logo.jpg" alt="" width="54" height="54"><span>MASTER7<small>MEMBER SERVICES</small></span></a>
<nav class="m7-home-links" aria-label="主要导航"><a href="#services">服务功能</a><a href="#help">使用说明</a><a class="m7-home-signin" href="/signin">会员登录</a></nav>
</header>
<main>
<section class="m7-home-hero" aria-labelledby="m7-home-title">
<p class="m7-home-eyebrow">MASTER7 / SERVICE PORTAL</p>
<h1 id="m7-home-title">清晰连接服务<span>安心处理每件事</span></h1>
<p class="m7-home-intro">使用安全的会员服务平台查看公告、提交客服申请和跟进处理进度。已有账号可直接登录；新账号需经管理员审核后才能使用。</p>
<div class="m7-home-actions"><a class="primary" href="/signin">进入会员服务</a><a class="secondary" href="/register">申请服务账号</a></div>
</section>
<section class="m7-home-section" id="services" aria-labelledby="m7-home-services">
<p class="m7-home-eyebrow">SERVICE FEATURES</p><h2 id="m7-home-services">常用服务，一目了然</h2>
<p class="m7-home-caption">以下功能需要登录，实际内容以账号权限为准。</p>
<div class="m7-home-grid">
<article class="m7-home-card"><span class="m7-home-num">01 / UPDATES</span><h3>服务公告</h3><p>登录后阅读适用于你账号的最新服务通知和说明。</p></article>
<article class="m7-home-card"><span class="m7-home-num">02 / SUPPORT</span><h3>客服申请</h3><p>向服务团队提交问题，并在会员区跟进回复与处理状态。</p></article>
<article class="m7-home-card"><span class="m7-home-num">03 / SECURITY</span><h3>账号安全</h3><p>通过受保护的账号页面管理登录凭据和恢复资料。</p></article>
</div>
</section>
<section class="m7-home-help" id="help" aria-labelledby="m7-home-help-title"><div><h2 id="m7-home-help-title">已有服务账号？</h2><p>请先登录会员中心。管理后台仅对经过授权的工作人员开放。</p></div><a class="secondary" href="/signin">前往登录</a></section>
</main>
<footer class="m7-home-footer">MASTER7 · 客户服务门户。此入口仅提供公告、客服及账户服务，不提供游戏或资金交易。</footer>
</div>`;
}
