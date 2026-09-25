import { storeLocalToIso, isoToStoreLocal } from '../../../../packages/domain/src/store-time';
import { cashierPage } from './pages/cashier';
import { controlPage } from './pages/control';
import { voicePage } from './pages/voice';
import { campusPage } from './pages/campus';
import { crmPage } from './pages/crm';
import { importsPage } from './pages/imports';
import { contentPage } from './pages/content';
import { campaignsPage } from './pages/campaigns';
import { brandPage } from './pages/brand';
import { overviewPage } from './pages/overview';
import { adminCss } from './styles';
import { adminApp } from './admin-app';
import { renderDocument } from './page-shell';
import { installABWorkspace } from './ab-workspace';
import { abWorkspaceCss } from './ab-styles';



export function renderAdminPage(surface: 'admin' | 'staff' | 'review' = 'admin'): string {
  return renderDocument({ surface, lang: 'zh-CN', title: 'ADDA Growth OS · 工作台', css: adminCss + abWorkspaceCss, body: `
<header class="app-header"><a class="brand" href="/admin" aria-label="ADDA 工作台"><img class="brand-symbol" src="/assets/brand/suiwu-lotus-mark.png" alt="SUIWU 随物 Logo"><span><span class="brand-name">ADDA <i>GROWTH OS</i></span><small>SUIWU 随物旗下品牌</small></span></a><div class="header-actions"><button id="nav-toggle" class="btn secondary small" type="button" aria-expanded="false" aria-controls="workspace-nav">菜单</button><label class="store-switch">门店<select id="workspace-store" aria-label="当前门店" disabled><option>登录后选择</option></select></label><span id="mode" class="chip">连接中</span><span id="user-label"></span><span class="language-switch"><button class="btn secondary small" id="lang-zh" type="button" aria-pressed="true">中文</button><button class="btn secondary small" id="lang-en" type="button" aria-pressed="false">English</button></span><button class="btn secondary small" id="logout" hidden>退出登录</button></div></header>
<div class="wrap"><div id="notice" class="notice" role="status">正在连接服务…</div><div id="production-empty" class="notice" hidden>空生产库：请先配置品牌资料、门店、菜单和所有者邀请。</div>
<section id="login" class="login"><div class="login-brand" aria-label="SUIWU 母品牌"><img src="/assets/brand/f78fd9085f6bde2ab8101aac1de72da9.jpg" alt="SUIWU 随物 · Lifestyle Medicine Management"><p>ADDA · SUIWU 随物旗下品牌</p></div><div class="card"><p class="eyebrow">Welcome back</p><h1>登录工作台</h1><p class="muted">使用门店账号继续。演示数据与真实业务分开。</p><form id="login-form"><div class="fields"><label class="full">邮箱 / Email<input id="email" type="email" autocomplete="username" required></label><label class="full">密码 / Password<input id="password" type="password" autocomplete="current-password" required></label></div><div class="actions"><button class="btn">登录</button></div></form><p id="login-result" role="status"></p></div></section>
<div id="workspace" class="layout" hidden><nav id="workspace-nav" class="nav" aria-label="工作台模块"><div class="surface-switch"><a href="/admin">运营</a><a href="/review">审核</a><a href="/staff">收银</a></div><span class="nav-caption">YOUR WORKSPACE</span><button data-page="overview" aria-current="page"><span class="nav-index" aria-hidden="true">01</span><span class="nav-label">总览</span><span class="nav-arrow" aria-hidden="true">↗</span></button><button data-page="imports"><span class="nav-index" aria-hidden="true">02</span><span class="nav-label">POS 与指标</span><span class="nav-arrow" aria-hidden="true">↗</span></button><button data-page="content"><span class="nav-index" aria-hidden="true">03</span><span class="nav-label">内容审批</span><span class="nav-arrow" aria-hidden="true">↗</span></button><button data-page="voice"><span class="nav-index" aria-hidden="true">04</span><span class="nav-label">顾客反馈</span><span class="nav-arrow" aria-hidden="true">↗</span></button><button data-page="brand"><span class="nav-index" aria-hidden="true">05</span><span class="nav-label">品牌与菜单</span><span class="nav-arrow" aria-hidden="true">↗</span></button><button data-page="campaigns"><span class="nav-index" aria-hidden="true">06</span><span class="nav-label">活动与优惠</span><span class="nav-arrow" aria-hidden="true">↗</span></button><button data-page="crm"><span class="nav-index" aria-hidden="true">07</span><span class="nav-label">会员触达</span><span class="nav-arrow" aria-hidden="true">↗</span></button><button data-page="campus"><span class="nav-index" aria-hidden="true">08</span><span class="nav-label">校园活动</span><span class="nav-arrow" aria-hidden="true">↗</span></button><button data-page="control"><span class="nav-index" aria-hidden="true">09</span><span class="nav-label">日报与连接器</span><span class="nav-arrow" aria-hidden="true">↗</span></button><button data-page="cashier"><span class="nav-index" aria-hidden="true">11</span><span class="nav-label">收银与现场核验</span><span class="nav-arrow" aria-hidden="true">↗</span></button></nav><main id="main-content" tabindex="-1">
${overviewPage}
${brandPage}
${campaignsPage}
${contentPage}
${importsPage}
${crmPage}
${campusPage}
${voicePage}
${controlPage}
${cashierPage}
</main></div></div>`, script: `function __name(target,value){Object.defineProperty(target,'name',{value,configurable:true});return target}(${adminApp.toString()})(${installABWorkspace.toString()}, {localToIso:${storeLocalToIso.toString()},isoToLocal:${isoToStoreLocal.toString()}});` });
}

