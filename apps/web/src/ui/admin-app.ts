import type { installABWorkspace } from './ab-workspace';

export function adminApp(mountAB: typeof installABWorkspace, times: {localToIso:(value:string,timezone:string)=>string|null;isoToLocal:(value:string,timezone:string)=>string}): void {
  const $ = (id: string): HTMLElement => document.getElementById(id)!;
  const v = (form: HTMLFormElement, name: string): string => String(new FormData(form).get(name) || '').trim();
  const x = (input: unknown): string => String(input ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
  let adminLanguage: 'zh' | 'en' = 'zh';
  let currentStore = ''; let scopeInitialized = false; let refreshEpoch = 0; let acting = false;
  let activePage = location.hash.slice(1) || 'overview';
  const surface = document.body.dataset.surface || 'admin';
  const tx = (zh:string,en:string):string => adminLanguage === 'en' ? en : zh;

  const adminEnglish: Record<string,string> = {
    '菜单':'Menu','运营':'Manage','审核':'Review','收银':'Store','收银与现场核验':'Store operations','全部授权门店':'All authorized stores','登录后选择':'Sign in first','优惠券令牌':'Coupon token','POS 订单号':'POS order reference','核验并保留':'Verify and reserve','券记录 ID':'Coupon record ID','订单来源':'Order source','匹配已导入订单':'Match imported order','现场活动签到':'Event check-in','核验已报名会员':'Verify registered member','01 · 核验并保留券':'01 · Verify and reserve','02 · 匹配权威订单':'02 · Match authoritative order','保存改稿':'Save new draft','编辑内容':'Edit content','历史版本':'Revision history','退回':'Reject','母品牌与子品牌':'Parent and endorsed brand','门店增长工作台':'Store growth workspace','退出登录':'Sign out','中文':'中文','连接中':'Connecting','正在连接服务…':'Connecting to the service…','空生产库：请先配置品牌资料、门店、菜单和所有者邀请。':'Empty production database: configure the brand, store, menu, and owner invitation first.',
    '登录工作台':'Sign in to workspace','使用门店账号继续。演示数据与真实业务分开。':'Use your store account. Demo data is separate from live business data.','邮箱 / Email':'Email','密码 / Password':'Password','登录':'Sign in',
    '总览':'Overview','POS 与指标':'POS and metrics','内容审批':'Content review','顾客反馈':'Customer feedback','品牌与菜单':'Brand and menu','活动与优惠':'Campaigns and offers','会员触达':'Member outreach','校园活动':'Campus events','日报与连接器':'Daily reports and connectors',
    '今天先处理什么':'What needs attention today','待办和指标来自当前门店。没有可靠订单数据时保留“缺失”。':'Tasks and metrics use the current store. Unreliable order data remains missing.','品牌资料待补':'Brand facts to complete','渠道状态':'Connector status','订单数据':'Order data','内容待办':'Content to review','反馈工单':'Feedback cases','暂无待补品牌资料。':'No missing brand facts.','演示环境已就绪。外部渠道未配置时仅支持受控的人工流程。':'Demo is ready. External channels are unavailable; controlled manual workflows are available.','环境已就绪，请按资料和审批状态继续。':'The environment is ready. Check source facts and approval status before proceeding.','服务未就绪，请检查本地进程。':'The service is unavailable. Check the local process.',
    '品牌事实、价格和素材授权先录入，再明确审批。':'Enter brand facts, prices, and asset rights, then approve them.','品牌事实':'Brand facts','以 JSON 录入已确认资料，例如 {"brand_name":"ADDA TEA"}。提交后仍需审批。':'Enter confirmed facts as JSON, for example {"brand_name":"ADDA TEA"}. Approval is still required.','来源说明':'Source note','适用门店':'Store scope','整个租户':'All stores','事实 JSON':'Facts JSON','保存待审版本':'Save for review','待补项与版本':'Missing facts and revisions','菜单产品':'Menu products','门店':'Store','名称':'Name','初始价格（最小单位）':'Initial price (minor units)','添加产品':'Add product','添加价格版本':'Add price revision','产品':'Product','价格（最小单位）':'Price (minor units)','状态':'Status','待审':'Pending review','批准':'Approved','来源':'Source','保存价格':'Save price','素材授权元数据':'Asset rights metadata','这里只记录文件路径和授权状态，不上传素材文件。':'Record file paths and rights status here; no asset file is uploaded.','素材路径':'Asset path','校验值':'Checksum','授权状态':'Rights status','待核验':'Needs verification','授权用途（逗号分隔）':'Allowed uses (comma separated)','登记素材':'Register asset',
    '活动先保存草稿并关联已核实的产品与素材；来源链接只携带随机令牌。':'Save a campaign draft and link verified products and assets. Source links contain random tokens only.','新建活动':'New campaign','活动名称':'Campaign name','活动目标':'Campaign objective','预算（最小单位）':'Budget (minor units)','创建草稿':'Create draft','关联产品与素材':'Link products and assets','活动':'Campaign','产品（可多选）':'Products (multiple)','素材（可多选）':'Assets (multiple)','保存关联':'Save links','来源链接':'Source link','来源名称':'Source name','渠道':'Channel','人工/线下':'Manual / offline','二维码':'QR code','社交平台':'Social media','生成链接':'Create link','原始链接只在创建时展示，请立即保存。':'The source link appears only when created. Save it now.','活动列表':'Campaign list','创建优惠':'Create offer','条款':'Terms','有效天数':'Valid days','最大发放量':'Maximum issues','优惠列表':'Offer list',
    '逐语种审阅、孟语复核和审批后才能导出；导出不代表发布。':'Review each language, complete Bengali review, and approve before export. Export is not publication.','生成内容草稿':'Generate content draft','人工发布':'Manual publication','内容支柱':'Content pillar','目标指标':'Target metric','生成草稿':'Generate draft','演示环境使用确定性样例提供者。':'Demo mode uses a deterministic sample provider.','内容详情':'Content detail','版本队列':'Revision queue',
    'CSV 先预览错误与来源范围，再人工确认提交。':'Preview CSV errors and source scope, then confirm the import.','导入 CSV':'Import CSV','类型':'Type','订单':'Orders','退款':'Refunds','会员':'Members','来源标识':'Source identifier','确认完整至':'Complete through','CSV 文件':'CSV file','或粘贴 CSV':'Or paste CSV','预览导入':'Preview import','确认提交':'Confirm import','指标质量':'Metric quality','导入记录':'Import history',
    '按规则预览受众、冻结名单，再审批模板和预算。无连接器时发送会被阻断。':'Preview an audience, freeze the list, then approve the template and budget. Sending is blocked without a connector.','预览分群':'Preview segment','规则':'Rule','已注册未首购':'Registered, no purchase','首购未复购':'One purchase, no repeat','14 天未活跃':'Inactive for 14 days','同意营销':'Marketing opt-in','查看人数':'View count','创建触达任务':'Create outreach task','任务名称':'Task name','人工':'Manual','模板 ID':'Template ID','模板文案':'Template copy','保留组 %':'Holdout %','我已核实模板':'I verified this template','冻结受众并创建':'Freeze audience and create','触达队列':'Outreach queue',
    '确认日期和容量，开放报名后才可登记签到。':'Confirm dates and capacity. Registration and check-in require an open event.','活动模板':'Event template','模板':'Template','容量':'Capacity','开始':'Start','结束':'End','补齐草稿日程':'Complete draft schedule','活动草稿':'Event draft','保存日程':'Save schedule','校园活动项目':'Campus event','校园活动列表':'Campus event list','报名':'Registration','会员 ID':'Member ID','登记报名':'Register member','签到':'Check-in','确认签到':'Confirm check-in','伙伴资料':'Partner records','公开来源 URL':'Public source URL','已有联系许可':'Contact permission recorded','登记伙伴':'Register partner','机构':'Organization','社团':'Club',
    '记录、处理、审批回复并留存人工执行证据。':'Record feedback, approve replies, and retain evidence of manual action.','登记反馈':'Record feedback','顾客原话':'Customer statement','保存反馈':'Save feedback','反馈列表':'Feedback list','工单与回复':'Cases and replies','工单':'Case','方式':'Method','回复文案':'Reply copy','保存回复草稿':'Save reply draft','人工任务':'Manual tasks','我的任务':'My tasks','完成证据':'Completion evidence','记录人工处理':'Record manual action','结案':'Close case','结案证据':'Closure evidence','结案并留存证据':'Close with evidence',
    '日报标出数据质量；人工导出与真实外部发送分别显示。':'Daily reports show data quality. Manual exports and external delivery are distinct.','日报':'Daily reports','生成今天的日报':'Generate today’s report','任务':'Tasks','记录完成':'Record completion','连接器状态':'Connector status',
    '请选择':'Select','进入处理 →':'Open →','批准版本':'Approve revision','复制':'Copy','查看':'View','孟语复核':'Bengali review','提交':'Submit','导出':'Export','人工导出预览':'Preview manual export','尝试发送':'Attempt dispatch','开放':'Open','关闭':'Close','补齐日程':'Complete schedule','处理':'Handle','转人工执行':'Create manual task','查看分析':'View analysis','标记已解决':'Mark resolved','暂无活动。':'No campaigns yet.','暂无优惠。':'No offers yet.','暂无内容草稿。':'No content drafts yet.','暂无导入。':'No imports yet.','暂无触达任务。':'No outreach tasks yet.','暂无校园活动。':'No campus events yet.','暂无伙伴资料。':'No partner records yet.','暂无反馈。':'No feedback yet.','暂无工单。':'No cases yet.','暂无人工任务。':'No manual tasks yet.','尚未生成日报。':'No daily reports yet.','暂无行动任务。':'No action tasks yet.','暂无连接器状态。':'No connector status available.'
  };
  const adminPhrases: Array<[string,string]> = [['日程：','Schedule: '],['报名 ','Registered '],['签到 ','Checked in '],['负责人：','Owner: '],['截止：','Due: '],['目标：','Objective: '],['缺失：','Missing: '],['到期：','Expires: '],['已发放 ','Issued '],['授权用途：','Allowed uses: '],['价格版本 ','Price revision '],['创建：','Created: '],['有效 ','Valid '],['错误 ','Errors '],['预算 ','Budget '],['版本 ','Revision '],['质量：','Quality: '],['完整至：','Complete through: '],['净营收：','Net revenue: '],['合格订单：','Qualified orders: ']];
  const originalText = new WeakMap<Text,{ original: string; translated: string }>();
  function translateAdmin(): void {
    document.documentElement.lang=adminLanguage==='en'?'en':'zh-CN';
    $('lang-zh').setAttribute('aria-pressed',String(adminLanguage==='zh')); $('lang-en').setAttribute('aria-pressed',String(adminLanguage==='en'));
    document.querySelector('.nav')?.setAttribute('aria-label',adminLanguage==='en'?'Workspace modules':'工作台模块');
    $('content-detail').setAttribute('aria-label',adminLanguage==='en'?'Content detail':'内容详情');
    $('daily-detail').setAttribute('aria-label',adminLanguage==='en'?'Daily report detail':'日报详情');
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT); let node: Node | null;
    while((node=walker.nextNode())) { if(node.parentElement?.closest('script,style,[data-user-content]')) continue; const textNode=node as Text; const previous=originalText.get(textNode); const current=textNode.textContent||''; const raw=previous&&current===previous.translated?previous.original:current; const key=raw.trim(); const english=adminEnglish[key]; if(adminLanguage==='en'){ let translated=english?raw.replace(key,english):raw; if(!english) for(const [chinese,phrase] of adminPhrases) translated=translated.split(chinese).join(phrase); if(translated!==raw){ textNode.textContent=translated; originalText.set(textNode,{original:raw,translated}); } } else if(previous&&current===previous.translated){ textNode.textContent=previous.original; originalText.delete(textNode); } }
  }
  let me: any = null; let health: any = null; let pendingImport = ''; let latestLink = ''; let currentFeedbackId = '';
  const db: Record<string, any> = {};
  const loadErrors: Record<string, string> = {};
  const can = (permission: string): boolean => Boolean(me?.actor?.permissions?.includes(permission));
  const notice = (message: string, kind = ''): void => { $('notice').textContent = message; $('notice').className = 'notice' + (kind ? ' ' + kind : ''); translateAdmin(); };
  const empty = (message: string): string => '<div class="empty">' + x(message) + '</div>';
  const button = (action: string, id: string, label: string, allowed = true): string => allowed ? '<button type="button" class="btn small secondary" data-action="' + x(action) + '" data-id="' + x(id) + '">' + x(label) + '</button>' : '';
  const row = (title: unknown, meta: string, status = '', actions = ''): string => '<div class="row"><div class="row-title"><span data-user-content>' + x(title) + '</span>' + (status ? '<span class="badge' + (/draft|pending|needs|blocked|missing/.test(status) ? ' warn' : '') + '">' + x(status) + '</span>' : '') + '</div><div class="row-meta">' + meta + '</div>' + (actions ? '<div class="row-actions">' + actions + '</div>' : '') + '</div>';
  const renderList = (id: string, html: string, noData: string): void => { $(id).innerHTML = html || empty(noData); };
  const date = (input: unknown): string => input ? new Date(String(input)).toLocaleString(adminLanguage==='en'?'en-GB':'zh-CN', {timeZone:me?.stores?.find((s:any)=>s.id===currentStore)?.timezone || 'Asia/Dhaka'}) : tx('未确认','Not confirmed');
  const money = (input: unknown): string => typeof input === 'number' ? (input / 100).toLocaleString() + ' ' + (me?.stores?.find((s:any)=>s.id===currentStore)?.currency || 'BDT') : '缺失';
  async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
    const target=new URL(path,location.origin); if(currentStore && !['/api/me','/api/healthz','/api/auth/logout'].includes(target.pathname)) target.searchParams.set('store_id',currentStore);
    const response = await fetch(target, { method, credentials: 'same-origin', headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-csrf-token': me?.csrf_token || '' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    let data: any = {}; try { data = await response.json(); } catch {}
    if (!response.ok) { const messages: Record<string,string> = { event_date_required:'请先补齐活动开始与结束时间。', event_date_invalid:'活动结束时间必须晚于开始时间。', event_not_open:'活动尚未开放。', registration_not_found:'请先登记该会员报名。', event_capacity_full:'活动人数已满。', manual_reply_evidence_required:'请先记录人工回复的执行证据。' }; throw Object.assign(new Error(messages[data.error_code] || data.error_code || data.message || '请求失败：' + response.status), {status:response.status}); }
    return data;
  }
  const pagePermissions: Record<string,string> = {overview:'report:read',orchestration:'report:read',brand:'brand:read',campaigns:'campaign:read',content:'campaign:read',imports:'report:read',crm:'outreach:read',campus:'campaign:read',voice:'report:read',control:'report:read',cashier:'campaign:read'};
  function permitted(name:string): boolean {
    if (!me) return true;
    if (me.role==='CASHIER') return name==='cashier';
    if (surface==='staff') return name==='cashier' && (can('campaign:create') || me.role==='CASHIER');
    if (surface==='review' && !['content','brand','voice'].includes(name)) return false;
    return name in pagePermissions && can(pagePermissions[name]) && (name!=='cashier' || can('campaign:create'));
  }
  function page(name: string, focus = true): void {
    if (!document.getElementById('page-'+name) || !permitted(name)) name = me?.role==='CASHIER'||surface==='staff' ? 'cashier' : surface==='review' ? 'content' : 'overview';
    activePage=name;
    document.querySelectorAll<HTMLButtonElement>('.nav button[data-page]').forEach(b => b.setAttribute('aria-current', b.dataset.page === name ? 'page' : 'false'));
    document.querySelectorAll<HTMLElement>('.page').forEach(section => { section.hidden = section.id !== 'page-' + name; });
    document.body.dataset.menu='closed'; $('nav-toggle').setAttribute('aria-expanded','false');
    if (location.hash !== '#'+name) history.pushState(null,'','#'+name);
    if (focus) { const heading=document.querySelector<HTMLElement>('#page-'+name+' h1'); heading?.setAttribute('tabindex','-1'); heading?.focus({preventScroll:true}); window.scrollTo({top:0,behavior:'auto'}); }
  }
  function permissions(): void {
    document.querySelectorAll<HTMLButtonElement>('.nav button[data-page]').forEach(b=>b.hidden=!permitted(b.dataset.page!));
    document.querySelectorAll<HTMLAnchorElement>('.surface-switch a').forEach(a=>{a.setAttribute('aria-current',a.pathname===('/'+(me?.role==='CASHIER'?'staff':surface))?'page':'false');});
    const forms:Record<string,string>={'brand-form':'brand:write','product-form':'product:write','price-form':'product:write','asset-form':'asset:write','campaign-form':'campaign:create','campaign-resources-form':'campaign:create','source-form':'campaign:create','offer-form':'campaign:create','content-form':'campaign:create','import-form':'import:write','segment-form':'outreach:read','outreach-form':'outreach:create','event-form':'campaign:create','event-schedule-form':'campaign:create','registration-form':'campaign:create','checkin-form':'campaign:create','partner-form':'campaign:create','feedback-form':'campaign:create','reply-form':'campaign:create','voice-task-form':'campaign:create','case-resolve-form':'campaign:create','task-form':'report:read'};
    for(const [id,permission] of Object.entries(forms)) $(id).hidden=!can(permission);
    $('content-form').closest<HTMLElement>('.card')!.hidden=!can('campaign:create')||surface==='review';
    const reviewGrid=$('content-form').closest<HTMLElement>('.grid'); if(reviewGrid) reviewGrid.style.gridTemplateColumns=surface==='review'?'1fr':'';
    page(activePage,false);
  }
  function selectOptions(selector: string, options: Array<{ id: string; label: string }>): void {
    document.querySelectorAll<HTMLSelectElement>(selector).forEach(select => { const prev = select.value; select.innerHTML = '<option value="">请选择</option>' + options.map(o => '<option value="' + x(o.id) + '">' + x(o.label) + '</option>').join(''); if (options.some(o => o.id === prev)) select.value = prev; else if (options.length === 1) select.value = options[0].id; });
  }
  const ab = mountAB({ api, page, can, snapshot: () => ({ me, health, db, errors: loadErrors, scope: currentStore }) });
  for (const id of ['lang-zh', 'lang-en']) $(id).addEventListener('click', () => { setTimeout(() => ab.update(), 0); });
  async function refresh(): Promise<void> {
    const epoch=++refreshEpoch;
    let nextMe:any=null;
    try { health=await api('/api/healthz'); if(epoch!==refreshEpoch)return; $('mode').textContent=health.mode.toUpperCase(); $('production-empty').hidden=!(health.mode==='production'&&!health.has_business_data); }
    catch { if(epoch!==refreshEpoch)return; health=null; notice(tx('服务连接失败，请重试。','Service unavailable. Retry.'),'error'); }
    try { nextMe=await api('/api/me'); } catch(error) { if((error as {status?:number}).status!==401 && me){notice(tx('账号状态读取失败，未展示新的数据。','Account state unavailable. No fresh data displayed.'),'error');return;} }
    if(epoch!==refreshEpoch)return;
    me=nextMe;
    $('login').hidden=Boolean(me); $('workspace').hidden=!me; $('logout').hidden=!me; $('user-label').textContent=me?me.user.display_name+' · '+me.role:'';
    if(!me){for(const key of Object.keys(db))delete db[key]; scopeInitialized=false; ($('workspace-store') as HTMLSelectElement).disabled=true; ab.update();translateAdmin();return;}
    if(!scopeInitialized){const requested=new URL(location.href).searchParams.get('store');currentStore=requested==='all'?'':me.store_ids.includes(requested)?requested:me.store_ids[0]||'';scopeInitialized=true;}
    if(currentStore&&!me.store_ids.includes(currentStore))currentStore=me.store_ids[0]||'';
    const selector=$('workspace-store') as HTMLSelectElement;
    selector.innerHTML='<option value="">'+tx('全部授权门店','All authorized stores')+'</option>'+(me.stores||[]).map((store:any)=>'<option value="'+x(store.id)+'">'+x(store.name)+'</option>').join(''); selector.value=currentStore;selector.disabled=false;
    const sources:Array<[string,string,string]>=[['brand','/api/brand/overview','brand:read'],['campaigns','/api/campaigns','campaign:read'],['offers','/api/offers','campaign:read'],['content','/api/content','campaign:read'],['imports','/api/imports','brand:read'],['metrics','/api/metrics','report:read'],['outreach','/api/outreach','outreach:read'],['events','/api/events','campaign:read'],['templates','/api/events/templates','campaign:read'],['partners','/api/partners','campaign:read'],['feedback','/api/feedback','report:read'],['cases','/api/support-cases','report:read'],['daily','/api/reports/daily','report:read']];
    await Promise.all(sources.map(async([key,path,permission])=>{
      if(!can(permission)){db[key]={};loadErrors[key]=tx('无权读取','Not authorized');return;}
      try{const data=await api(path);if(epoch!==refreshEpoch)return;db[key]=data;delete loadErrors[key];}
      catch(error){if(epoch!==refreshEpoch)return;db[key]={};loadErrors[key]=tx('读取失败：','Read failed: ')+(error instanceof Error?error.message:String(error));}
    }));
    if(epoch!==refreshEpoch)return;
    render();ab.update();permissions();
    document.querySelectorAll<HTMLInputElement>('input[type=datetime-local]').forEach(input=>{const form=input.closest('form');const selected=(form?.querySelector('[name=store_id]')as HTMLSelectElement)?.value||currentStore;input.title=tx('门店时区：','Store timezone: ')+(me?.stores?.find((store:any)=>store.id===selected)?.timezone || 'Asia/Dhaka');});
    const pageSources:Record<string,string[]>={brand:['brand'],campaigns:['campaigns','offers'],content:['content'],imports:['imports','metrics'],crm:['outreach'],campus:['events','partners'],voice:['feedback','cases'],control:['daily'],cashier:['events']};
    for (const [name,keys] of Object.entries(pageSources)) {
      const section=$('page-'+name);let alert=section.querySelector<HTMLElement>('[data-load-error]');
      if(!alert){alert=document.createElement('div');alert.dataset.loadError='true';alert.className='notice error';alert.setAttribute('role','alert');section.prepend(alert);}
      const problems=keys.filter(key=>loadErrors[key]);alert.hidden=!problems.length;
      alert.textContent=problems.length?tx('部分数据未读取，空列表不代表没有记录：','Some data was not loaded. Empty lists are not evidence of no records: ')+problems.map(key=>key+' · '+loadErrors[key]).join('; '):'';
    }

    if($('notice').textContent?.includes('正在连接'))notice(tx('已连接。当前演示/测试资料与真实业务分开。','Connected. Demo/test records are separate from live business.'));
  }
  function render(): void {
    const metric=db.metrics?.summary; const connectors=health?.connectors||{};
    selectOptions('[data-store]', me.store_ids.filter((id:string)=>!currentStore||id===currentStore).map((id: string) => ({ id, label: (me.stores||[]).find((s:any)=>s.id===id)?.name || id })));
    selectOptions('#cashier-event',(db.events?.items||[]).filter((e:any)=>e.status==='open').map((e:any)=>({id:e.id,label:e.name})));
    selectOptions('[data-campaign]', (db.campaigns?.items || []).map((c: any) => ({ id: c.id, label: c.name + ' · ' + c.status })));
    const resourceOptions = (id: string, items: Array<{ id: string; label: string }>): void => { const select = $(id) as HTMLSelectElement; const selected = new Set(Array.from(select.selectedOptions).map(option => option.value)); select.innerHTML = items.map(item => '<option value="' + x(item.id) + '"' + (selected.has(item.id) ? ' selected' : '') + '>' + x(item.label) + '</option>').join(''); };
    resourceOptions('campaign-products', (db.brand?.products || []).map((p: any) => ({ id: p.id, label: p.names?.en || p.external_sku })));
    resourceOptions('campaign-assets', (db.brand?.assets || []).map((a: any) => ({ id: a.id, label: a.storage_key + ' · ' + a.rights_status })));
    selectOptions('#price-product', (db.brand?.products || []).map((p: any) => ({ id: p.id, label: p.names?.en || p.external_sku })));
    selectOptions('#event-template', (db.templates?.items || []).map((t: any) => ({ id: t.id, label: t.name })));
    selectOptions('[data-event]', (db.events?.items || []).filter((a: any) => a.status === 'open').map((a: any) => ({ id: a.id, label: a.name + ' · ' + a.status })));
    selectOptions('#schedule-event', (db.events?.items || []).filter((a: any) => a.status === 'draft').map((a: any) => ({ id: a.id, label: a.name })));
    selectOptions('#voice-task-select', (db.cases?.tasks || []).filter((t: any) => t.owner_user_id === me.user.id && t.status === 'open').map((t: any) => ({ id: t.id, label: t.kind + ' · ' + t.id.slice(0, 8) })));
    selectOptions('#resolve-case', (db.cases?.items || []).filter((c: any) => !['resolved','closed'].includes(c.status)).map((c: any) => ({ id: c.id, label: c.id.slice(0,8) + ' · ' + c.status })));
    selectOptions('#reply-case', (db.cases?.items || []).filter((c: any) => !['resolved','closed'].includes(c.status)).map((c: any) => ({ id: c.id, label: c.id.slice(0,8) + ' · ' + c.status })));
    selectOptions('#task-select', (db.daily?.tasks || []).filter((t: any) => t.owner_user_id === me.user.id && t.status !== 'done').map((t: any) => ({ id: t.id, label: t.title })));
    renderList('brand-list',(db.brand?.needs_input || []).map((n:string) => row(n,'待补')).join('') + (db.brand?.revisions || []).map((r:any) => row('品牌版本 '+r.version,'创建：'+x(date(r.created_at)),r.status,button('approve-brand',r.id,'批准版本',can('brand:approve') && r.status!=='approved'))).join(''),'暂无品牌版本。');
    renderList('product-list',(db.brand?.products || []).map((p:any) => row(p.names?.en || p.external_sku,'SKU '+x(p.external_sku)+' · 价格版本 '+x(p.current_price_version_id || '未设置'),p.status)).join(''),'暂无产品。');
    renderList('asset-list',(db.brand?.assets || []).map((a:any) => row(a.storage_key,'授权用途：'+x((a.allowed_uses||[]).join(', ')||'未登记'),a.rights_status)).join(''),'暂无素材。');
    renderList('campaign-list',(db.campaigns?.items || []).map((c:any) => row(c.name,'目标：'+x(c.objective||'未填写')+' · 缺失：'+x((c.needs_input||[]).join(', ')||'无'),c.status,button('approve-campaign',c.id,'批准',can('campaign:approve') && c.status!=='approved'))).join(''),'暂无活动。');
    renderList('offer-list',(db.offers?.items || []).map((o:any) => row(o.name,'到期：'+x(date(o.valid_to))+' · 已发放 '+x(o.issued_count),o.status)).join(''),'暂无优惠。');
    if (latestLink) $('generated-link').innerHTML = '<a href="'+x(latestLink)+'" target="_blank" rel="noopener noreferrer">'+x(location.origin+latestLink)+'</a> '+button('copy-link','','复制');
    renderList('content-list',(db.content?.items || []).map((c:any) => row('内容版本 '+c.revision+' · '+c.id.slice(0,8),'缺失：'+x((c.needs_input||[]).join(', ')||'无'),c.status,button('content-view',c.id,'查看')+button('content-edit',c.id,'编辑内容',can('campaign:create'))+button('content-history',c.id,'历史版本')+button('content-review',c.id,'孟语复核',(can('brand:approve')||me.role==='LOCAL_REVIEWER')&&c.status==='needs_local_review')+button('content-submit',c.id,'提交',can('campaign:create')&&c.status==='draft'&&!(c.needs_input||[]).length)+button('content-approve',c.current_approval_id||'','批准',can('brand:approve')&&Boolean(c.current_approval_id)&&c.status==='pending_approval')+button('content-reject',c.current_approval_id||'','退回',can('brand:approve')&&Boolean(c.current_approval_id)&&c.status==='pending_approval')+button('content-export',c.id,'导出',can('campaign:create')&&c.status==='approved'))).join(''),'暂无内容草稿。');
    $('metric-summary').innerHTML = metric ? '<span class="chip">质量：'+x(metric.quality)+'</span><p>净营收：<strong>'+x(money(metric.net_revenue_minor))+'</strong><br>合格订单：<strong>'+x(metric.qualified_order_count ?? '—')+'</strong><br>完整至：'+x(metric.complete_through||'未确认')+'</p>' : empty('指标缺失：'+(db.metrics?.missing_reason||'orders_not_imported'));
    renderList('import-list',(db.imports?.items || []).slice().reverse().map((b:any) => row(b.file_name,x(b.kind)+' · '+x(b.source)+' · 有效 '+x(b.valid_row_count)+'/'+x(b.row_count)+' · 错误 '+x(b.error_count),b.status,button('commit-batch',b.id,'提交',can('import:write')&&b.status==='preview'&&b.error_count===0))).join(''),'暂无导入。');
    renderList('outreach-list',(db.outreach?.items || []).slice().reverse().map((o:any) => row(o.template_id,x(o.channel)+' · 预算 '+x(money(o.budget_minor)),o.status,button('outreach-submit',o.id,'提交/批准',(can('outreach:create')||can('outreach:approve'))&&o.status==='pending_approval')+button('outreach-export',o.id,'人工导出预览',can('member:export')&&o.status==='approved')+button('outreach-dispatch',o.id,'尝试发送',can('outreach:dispatch')&&o.status==='approved'))).join(''),'暂无触达任务。');
    renderList('event-list',(db.events?.items || []).map((a:any) => row(a.name,'日程：'+x(date(a.startsAt))+'—'+x(date(a.endsAt))+' · 报名 '+x(a.registrationCount ?? 0)+'/'+x(a.capacity)+' · 签到 '+x(a.checkinCount ?? 0),a.status,button('event-edit',a.id,'补齐日程',can('campaign:create')&&a.status==='draft')+button('event-open',a.id,'开放',can('campaign:create')&&a.status==='draft')+button('event-close',a.id,'关闭',can('campaign:create')&&a.status==='open'))).join(''),'暂无校园活动。');
    renderList('partner-list',(db.partners?.items || []).map((p:any) => row(p.name,x(p.sourceUrl||''),p.stage)).join(''),'暂无伙伴资料。');
    renderList('feedback-list',(db.feedback?.items || []).slice().reverse().slice(0,8).map((f:any) => row(f.evidence_excerpt||f.id,x(f.source)+' · '+x(date(f.received_at)),f.risk,button('feedback-view',f.id,'查看'))).join(''),'暂无反馈。');
    renderList('case-list',(db.cases?.items || []).map((c:any) => row('工单 '+c.id.slice(0,8),'截止：'+x(date(c.sla_due_at)),c.status,button('case-select',c.id,'处理',can('campaign:create')&&!['resolved','closed'].includes(c.status)))).join(''),'暂无工单。');
    renderList('voice-task-list',(db.cases?.tasks || []).map((t:any) => row(t.kind,'负责人：'+x(t.owner_user_id?.slice(0,8)||'未指派')+' · 截止：'+x(date(t.due_at)),t.status)).join(''),'暂无人工任务。');
    renderList('daily-list',(db.daily?.items || []).slice().reverse().slice(0,5).map((r:any) => row('日报 v'+r.version,'截至 '+x(date(r.as_of)),r.status,button('report-view',r.id,'查看分析'))).join(''),'尚未生成日报。');
    renderList('task-list',(db.daily?.tasks || []).map((t:any) => row(t.title,'负责人：'+x(t.owner_user_id.slice(0,8)),t.status)).join(''),'暂无行动任务。');
    renderList('connector-list',Object.entries(connectors).map(([name,s]:[string,any]) => row(name,x(s.reason||''),s.mode||'unconfigured')).join(''),'暂无连接器状态。');
    translateAdmin();
  }
  async function showFeedbackDetail(id: string): Promise<void> {
    const r=await api('/api/feedback/'+encodeURIComponent(id));
    $('reply-list').innerHTML='<h3>反馈详情</h3><p>'+x(r.original_text||r.item.evidence_excerpt)+'</p>'+(r.replies||[]).map((reply:any)=>row(reply.body||'无权查看回复原文',x(reply.channel),reply.status,button('reply-submit',reply.id,'提交',can('campaign:create')&&reply.status==='draft')+button('reply-approve',reply.id,'批准',can('brand:approve')&&reply.status==='pending_approval')+button('reply-execute',reply.id,'转人工执行',can('campaign:create')&&reply.status==='approved'))).join('');
  }
  async function act(fn: () => Promise<void>, message: string): Promise<void> {
    if(acting)return;acting=true;$('workspace').setAttribute('aria-busy','true');
    try{await fn();notice(message,'success');}catch(error){notice(error instanceof Error?error.message:String(error),'error');}
    finally{acting=false;$('workspace').setAttribute('aria-busy','false');}
    await refresh();if(currentFeedbackId&&!$('page-voice').hidden)try{await showFeedbackDetail(currentFeedbackId);}catch{}
  }

  function bind(id: string, fn: (form: HTMLFormElement) => Promise<void>, message: string): void { const form = $(id) as HTMLFormElement; form.addEventListener('submit', ev => { ev.preventDefault(); void act(() => fn(form),message); }); }
  const iso = (s: string, storeId=currentStore): string | null => times.localToIso(s,me?.stores?.find((store:any)=>store.id===storeId)?.timezone || 'Asia/Dhaka');
  const download = (name: string, payload: unknown): void => { const url = URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'})); const a = document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); };
  function modal(title:string,contents:string):HTMLDialogElement {
    const trigger=document.activeElement as HTMLElement;const d=document.createElement('dialog');d.className='ab-dialog';d.innerHTML='<div class="ab-card-head"><h2>'+x(title)+'</h2><button type="button" data-close aria-label="Close">×</button></div>'+contents;
    const close=()=>{d.close();d.remove();trigger?.isConnected&&trigger.focus();};d.querySelector('[data-close]')!.addEventListener('click',close);d.addEventListener('cancel',e=>{e.preventDefault();close();});document.body.append(d);d.showModal();return d;
  }
  async function editContent(id:string):Promise<void> {
    const r=await api('/api/content/'+encodeURIComponent(id));const data=r.package;
    const d=modal(tx('编辑内容','Edit content'),'<p>'+tx('保存会重置孟语复核并使旧审批失效。批准内容的历史快照保留。','Saving resets Bengali review and invalidates prior approval. Approved history remains immutable.')+'</p><form><label>中文操作说明<textarea name="notes">'+x(data.operator_notes_zh)+'</textarea></label>'+data.variants.map((v:any,i:number)=>'<div class="editor-variant"><h3>'+x(v.locale)+'</h3><label>Title<input name="title-'+i+'" value="'+x(v.title)+'" required></label><label>Caption<textarea name="caption-'+i+'" required>'+x(v.caption)+'</textarea></label></div>').join('')+'<p class="error-text" role="status"></p><button class="btn" type="submit">'+tx('保存改稿','Save new draft')+'</button></form>');
    d.querySelector('form')!.addEventListener('submit',e=>{e.preventDefault();const f=e.currentTarget as HTMLFormElement;const submit=f.querySelector<HTMLButtonElement>('button[type=submit]')!;if(submit.disabled)return;submit.disabled=true;data.operator_notes_zh=v(f,'notes');data.variants.forEach((item:any,i:number)=>{item.title=v(f,'title-'+i);item.caption=v(f,'caption-'+i);});void api('/api/content/'+encodeURIComponent(id),'PATCH',{package_data:data,expected_hash:r.item.content_hash}).then(async()=>{(d.querySelector('[data-close]') as HTMLButtonElement).click();notice(tx('已保存新稿，必须重新复核与审批。','Draft saved. Review and approval are required again.'),'success');await refresh();}).catch(error=>{f.querySelector('[role=status]')!.textContent=error.message;submit.disabled=false;});});
  }
  document.addEventListener('click', ev => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-page],button[data-action]'); if (!b) return;
    if (b.dataset.page) { page(b.dataset.page); return; }
    const id = b.dataset.id || ''; const action = b.dataset.action || '';
    if(action==='content-edit'){void editContent(id).catch(error=>notice(error.message,'error'));return;}
    if(action==='content-history'){void act(async()=>{const r=await api('/api/content/'+encodeURIComponent(id)+'/history');$('content-detail').innerHTML='<h3>'+tx('历史版本','Revision history')+'</h3>'+(r.items||[]).map((h:any)=>'<details class="row"><summary>'+x(h.reason)+' · '+x(date(h.capturedAt))+'</summary><code class="record-code">'+x(h.contentHash)+'</code><p data-user-content>'+x(h.revision.packageData.operator_notes_zh)+'</p>'+h.revision.packageData.variants.map((v:any)=>'<p data-user-content><strong>'+x(v.locale)+'</strong> '+x(v.caption)+'</p>').join('')+'</details>').join('');},'历史快照已读取。');return;}
    if(action==='content-reject'){const d=modal(tx('退回审批','Reject approval'),'<form><label>'+tx('退回原因','Reason')+'<textarea name="reason" required maxlength="2000"></textarea></label><p role="status" class="error-text"></p><button class="btn" type="submit">'+tx('确认退回','Reject')+'</button></form>');d.querySelector('form')!.addEventListener('submit',e=>{e.preventDefault();void api('/api/approvals/'+encodeURIComponent(id)+'/reject','POST',{reason:v(e.currentTarget as HTMLFormElement,'reason')}).then(async()=>{(d.querySelector('[data-close]') as HTMLButtonElement).click();await refresh();}).catch(error=>{d.querySelector('[role=status]')!.textContent=error.message;});});return;}
    if (action==='go-brand') { page('brand'); return; }
    if (action==='case-select') { ($('reply-case') as HTMLSelectElement).value=id; ($('resolve-case') as HTMLSelectElement).value=id; page('voice'); return; }
    if (action==='event-edit') { const event=(db.events?.items||[]).find((a:any)=>a.id===id); if(event){ ($('schedule-event') as HTMLSelectElement).value=id; (document.querySelector('#event-schedule-form [name=capacity]') as HTMLInputElement).value=String(event.capacity); for(const key of ['starts_at','ends_at']) { const value=event[key==='starts_at'?'startsAt':'endsAt']; (document.querySelector('#event-schedule-form [name='+key+']') as HTMLInputElement).value=value?times.isoToLocal(value,me?.stores?.find((store:any)=>store.id===event.storeId)?.timezone || 'Asia/Dhaka'):''; } ($('schedule-event') as HTMLElement).scrollIntoView({behavior:'smooth',block:'center'}); } return; }
    if (action==='report-view') { const r=(db.daily?.items||[]).find((item:any)=>item.id===id); if(r){ const section=(title:string,items:any[])=>'<h3>'+x(title)+'</h3>'+(items.length?items.map(item=>'<p>'+x(item.text||item.hypothesis||String(item))+'</p>').join(''):empty('暂无')); $('daily-detail').innerHTML='<strong>日报 v'+x(r.version)+' · '+x(r.status)+'</strong><p>数据完整至：'+x(r.complete_through||'未确认')+'</p>'+section('观察',r.observations||[])+section('假设',r.hypotheses||[])+section('建议',r.advice||[]); } return; }
    if (action==='copy-link') { void navigator.clipboard.writeText(location.origin+latestLink).then(()=>notice('链接已复制。','success')).catch(()=>notice('复制失败，请手动复制。','error')); return; }
    if (action==='content-view') { void act(async()=>{ const r=await api('/api/content/'+encodeURIComponent(id)); $('content-detail').innerHTML='<strong>来源</strong><p>'+x((r.package.sources||[]).map((s:any)=>s.excerpt).join(' · '))+'</p>'+(r.package.variants||[]).map((v:any)=>row(v.locale+' · '+v.review_status,'<strong>'+x(v.title)+'</strong><p>'+x(v.caption)+'</p>')).join(''); },'内容详情已展开。'); return; }
    if (action==='feedback-view') { currentFeedbackId=id; void showFeedbackDetail(id).then(()=>notice('反馈详情已展开。','success')).catch(error=>notice(error instanceof Error?error.message:String(error),'error')); return; }
    const handlers: Record<string,() => Promise<any>> = {
      'approve-brand':()=>api('/api/brand/revisions/'+encodeURIComponent(id)+'/approve','POST'),
      'approve-campaign':()=>api('/api/campaigns/'+encodeURIComponent(id),'PATCH',{status:'approved'}),
      'content-review':()=>api('/api/content/'+encodeURIComponent(id)+'/review-bn','POST',{decision:'reviewed'}),
      'content-submit':()=>api('/api/content/submit','POST',{revision_id:id}),
      'content-approve':()=>api('/api/approvals/'+encodeURIComponent(id)+'/approve','POST'),
      'content-export':async()=>{ const r=await api('/api/content/export','POST',{revision_id:id}); download('adda-content-'+id.slice(0,8)+'.json',r.package); },
      'commit-batch':()=>api('/api/imports/'+encodeURIComponent(id)+'/commit','POST'),
      'outreach-submit':()=>api('/api/outreach/'+encodeURIComponent(id)+'/submit','POST'),
      'outreach-export':async()=>{ const r=await api('/api/outreach/'+encodeURIComponent(id)+'/export','POST'); $('segment-preview').textContent='可人工处理 '+r.items.length+' 人；受政策阻断 '+r.blocked_count+' 人。无明文联系人。'; },
      'outreach-dispatch':async()=>{ const result=await api('/api/outreach/'+encodeURIComponent(id)+'/dispatch','POST'); if(result.delivery_mode==='external_blocked'||result.campaign?.status==='blocked') throw new Error('未发送：连接器未配置或发送政策阻断。'); return result; },
      'event-open':()=>api('/api/events/'+encodeURIComponent(id)+'/status','POST',{status:'open'}),
      'event-close':()=>api('/api/events/'+encodeURIComponent(id)+'/status','POST',{status:'closed'}),
      'reply-submit':()=>api('/api/reply-revisions/'+encodeURIComponent(id)+'/submit','POST'),
      'reply-approve':()=>api('/api/reply-revisions/'+encodeURIComponent(id)+'/approve','POST'),
      'reply-execute':()=>api('/api/reply-revisions/'+encodeURIComponent(id)+'/execute','POST')
    };
    if (handlers[action]) void act(handlers[action],'操作已完成。');
  });
  $('login-form').addEventListener('submit',ev=>{ ev.preventDefault(); void (async()=>{ try { const response=await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({email:($('email') as HTMLInputElement).value,password:($('password') as HTMLInputElement).value})}); const result=await response.json(); if(!response.ok) throw new Error(result.message||result.error_code); ($('password') as HTMLInputElement).value=''; $('login-result').textContent=''; notice('已登录：'+result.user.display_name,'success'); await refresh(); } catch(error){ $('login-result').textContent=error instanceof Error?error.message:'登录失败'; } })(); });
  $('lang-zh').addEventListener('click',()=>{ adminLanguage='zh'; translateAdmin(); });
  $('lang-en').addEventListener('click',()=>{ adminLanguage='en'; translateAdmin(); });
  $('logout').addEventListener('click',()=>{ void act(async()=>{ await api('/api/auth/logout','POST'); refreshEpoch++;me=null;scopeInitialized=false;latestLink='';currentFeedbackId='';clearDetails(); },'已退出登录。'); });
  bind('brand-form',async f=>{ await api('/api/brand/documents','POST',{source_type:'form',source_label:v(f,'source_label'),store_id:v(f,'store_id')||null,content:v(f,'content')}); f.reset(); },'品牌事实已保存，等待审批。');
  bind('product-form',async f=>{ const price=v(f,'price_minor'); await api('/api/products','POST',{store_id:v(f,'store_id'),external_sku:v(f,'external_sku'),names:{en:v(f,'name')},price_minor:price?Number(price):null}); f.reset(); },'产品已添加；价格仍需审批。');
  bind('price-form',async f=>{ await api('/api/products/'+encodeURIComponent(v(f,'product_id'))+'/prices','POST',{amount_minor:Number(v(f,'amount_minor')),status:v(f,'status'),source_citation:v(f,'source_citation')}); },'价格版本已保存。');
  bind('asset-form',async f=>{ await api('/api/media-assets','POST',{store_id:v(f,'store_id'),storage_key:v(f,'storage_key'),checksum:v(f,'checksum'),rights_status:v(f,'rights_status'),allowed_uses:v(f,'allowed_uses').split(',').map(s=>s.trim()).filter(Boolean)}); f.reset(); },'素材元数据已登记。');
  bind('campaign-form',async f=>{ const budget=v(f,'budget_minor'); await api('/api/campaigns','POST',{store_id:v(f,'store_id'),name:v(f,'name'),objective:v(f,'objective')||null,budget_minor:budget?Number(budget):null}); f.reset(); },'活动草稿已创建。');
  bind('campaign-resources-form',async f=>{ const chosen=(id:string)=>Array.from(($(id) as HTMLSelectElement).selectedOptions).map(option=>option.value); await api('/api/campaigns/'+encodeURIComponent(v(f,'campaign_id')),'PATCH',{product_ids:chosen('campaign-products'),asset_ids:chosen('campaign-assets')}); },'活动关联已保存；已有内容需要重新生成并审批。');
  bind('source-form',async f=>{ const r=await api('/api/campaigns/'+encodeURIComponent(v(f,'campaign_id'))+'/source-links','POST',{label:v(f,'label'),channel:v(f,'channel')}); latestLink=r.url; },'来源链接已生成，请立即复制。');
  bind('offer-form',async f=>{ const max=v(f,'max_redemptions'); await api('/api/offers','POST',{campaign_id:v(f,'campaign_id'),name:v(f,'name'),terms:v(f,'terms'),valid_to:new Date(Date.now()+Number(v(f,'days'))*86400000).toISOString(),max_redemptions:max?Number(max):undefined}); },'优惠已创建。');
  bind('content-form',async f=>{ await api('/api/content/generate','POST',{campaign_id:v(f,'campaign_id'),channel:v(f,'channel'),content_pillar:v(f,'content_pillar'),target_metric:v(f,'target_metric')}); },'内容草稿已生成，请逐语种审阅。');
  bind('import-form',async f=>{ const file=($('csv-file') as HTMLInputElement).files?.[0]; const content=file?await file.text():v(f,'content'); if(!content) throw new Error('请选择 CSV 文件或粘贴内容。'); const r=await api('/api/imports/preview','POST',{store_id:v(f,'store_id'),kind:v(f,'kind'),source:v(f,'source'),file_name:file?.name||'pasted.csv',content,complete_through:iso(v(f,'complete_through'),v(f,'store_id'))}); pendingImport=r.import.id; $('import-preview').innerHTML='<strong>有效 '+x(r.preview.valid_row_count)+'/'+x(r.preview.row_count)+' 行；错误 '+x(r.preview.error_count)+'</strong>'+(r.preview.errors||[]).slice(0,20).map((er:any)=>'<p class="fine">第 '+x(er.row_number)+' 行：'+x(er.message)+'</p>').join(''); ($('commit-import') as HTMLButtonElement).disabled=r.preview.error_count>0; },'预览完成，请核对后提交。');
  $('commit-import').addEventListener('click',()=>{ void act(async()=>{ if(!pendingImport) throw new Error('请先预览 CSV。'); await api('/api/imports/'+encodeURIComponent(pendingImport)+'/commit','POST'); pendingImport=''; ($('commit-import') as HTMLButtonElement).disabled=true; },'CSV 已提交，指标已刷新。'); });
  bind('segment-form',async f=>{ const r=await api('/api/segments/preview','POST',{store_id:v(f,'store_id'),rule:v(f,'rule')}); $('segment-preview').textContent='符合规则 '+r.count+' 人；样本已脱敏。'; },'受众预览已更新。');
  bind('outreach-form',async f=>{ await api('/api/outreach/preview','POST',{store_id:v(f,'store_id'),rule:v(f,'rule'),name:v(f,'name'),channel:v(f,'channel'),template_id:v(f,'template_id'),template_text:v(f,'template_text'),template_approved:new FormData(f).get('template_approved')==='on',budget_minor:Number(v(f,'budget_minor')),cost_per_attempt_minor:0,holdout_percent:Number(v(f,'holdout_percent'))}); },'触达草稿已创建。');
  bind('event-form',async f=>{ await api('/api/events','POST',{store_id:v(f,'store_id'),template_id:v(f,'template_id'),name:v(f,'name'),capacity:Number(v(f,'capacity')),starts_at:iso(v(f,'starts_at'),v(f,'store_id')||(db.events?.items||[]).find((e:any)=>e.id===v(f,'event_id'))?.storeId),ends_at:iso(v(f,'ends_at'),v(f,'store_id')||(db.events?.items||[]).find((e:any)=>e.id===v(f,'event_id'))?.storeId)}); f.reset(); },'活动草稿已创建。');
  bind('event-schedule-form',async f=>{ await api('/api/events/'+encodeURIComponent(v(f,'event_id')),'PATCH',{capacity:Number(v(f,'capacity')),starts_at:iso(v(f,'starts_at'),v(f,'store_id')||(db.events?.items||[]).find((e:any)=>e.id===v(f,'event_id'))?.storeId),ends_at:iso(v(f,'ends_at'),v(f,'store_id')||(db.events?.items||[]).find((e:any)=>e.id===v(f,'event_id'))?.storeId)}); f.reset(); },'活动日程已保存，可以开放报名。');
  bind('registration-form',async f=>{ await api('/api/events/'+encodeURIComponent(v(f,'event_id'))+'/registrations','POST',{member_id:v(f,'member_id')}); },'报名已登记。');
  bind('checkin-form',async f=>{ await api('/api/events/'+encodeURIComponent(v(f,'event_id'))+'/checkins','POST',{member_id:v(f,'member_id'),method:'staff_confirmed'}); },'签到已登记。');
  bind('partner-form',async f=>{ await api('/api/partners','POST',{name:v(f,'name'),kind:v(f,'kind'),source_url:v(f,'source_url'),contact_permission:new FormData(f).get('contact_permission')==='on'}); f.reset(); },'伙伴资料已登记。');
  bind('feedback-form',async f=>{ await api('/api/feedback','POST',{store_id:v(f,'store_id'),source:v(f,'source'),text:v(f,'text')}); f.reset(); },'反馈已保存。');
  bind('reply-form',async f=>{ const caseId=v(f,'case_id'); await api('/api/support-cases/'+encodeURIComponent(caseId)+'/replies','POST',{channel:v(f,'channel'),body:v(f,'body')}); currentFeedbackId=(db.cases?.items||[]).find((c:any)=>c.id===caseId)?.feedback_id||''; },'回复草稿已保存。');
  bind('voice-task-form',async f=>{ await api('/api/voice-tasks/'+encodeURIComponent(v(f,'task_id'))+'/complete','POST',{evidence:v(f,'evidence')}); f.reset(); },'人工处理证据已记录；仅代表操作员确认。');
  bind('case-resolve-form',async f=>{ await api('/api/support-cases/'+encodeURIComponent(v(f,'case_id')),'PATCH',{status:'closed',evidence:v(f,'evidence')}); f.reset(); },'工单已结案，证据已留存。');
  $('generate-report').addEventListener('click',()=>{ void act(async()=>{ await api('/api/reports/daily','POST'); },'日报已生成。'); });
  bind('task-form',async f=>{ await api('/api/control-tasks/'+encodeURIComponent(v(f,'task_id'))+'/complete','POST',{evidence:v(f,'evidence')}); },'任务完成证据已记录。');
  function clearDetails():void { for(const id of ['content-detail','daily-detail','reply-list','generated-link','import-preview','segment-preview','cashier-reserve-result','cashier-match-result','cashier-checkin-result']) $(id).replaceChildren();pendingImport='';($('commit-import') as HTMLButtonElement).disabled=true; }
  $('workspace-store').addEventListener('change',()=>{refreshEpoch++;currentStore=($('workspace-store') as HTMLSelectElement).value;latestLink='';currentFeedbackId='';clearDetails();const u=new URL(location.href);u.searchParams.set('store',currentStore||'all');history.replaceState(null,'',u);void refresh();});
  $('nav-toggle').addEventListener('click',()=>{const open=document.body.dataset.menu!=='open';document.body.dataset.menu=open?'open':'closed';$('nav-toggle').setAttribute('aria-expanded',String(open));});
  window.addEventListener('popstate',()=>page(location.hash.slice(1)||'overview',false));
  bind('cashier-reserve-form',async f=>{const r=await api('/api/redemptions/reserve','POST',{store_id:v(f,'store_id'),coupon_token:v(f,'coupon_token'),pos_order_ref:v(f,'pos_order_ref')});$('cashier-reserve-result').textContent=tx('已保留，待 POS 核验。券 ID：','Reserved, pending POS verification. Coupon ID: ')+r.coupon.id; const next=$('cashier-match-form') as HTMLFormElement;(next.elements.namedItem('coupon_id') as HTMLInputElement).value=r.coupon.id;(next.elements.namedItem('pos_order_ref') as HTMLInputElement).value=v(f,'pos_order_ref');(f.elements.namedItem('coupon_token') as HTMLInputElement).value='';},'券状态已保存；尚未计入成交。');
  bind('cashier-match-form',async f=>{const r=await api('/api/redemptions/'+encodeURIComponent(v(f,'coupon_id'))+'/match-pos','POST',{store_id:v(f,'store_id'),pos_order_ref:v(f,'pos_order_ref'),order_source:v(f,'order_source')});$('cashier-match-result').textContent=tx('POS 核验结果：','POS match result: ')+r.coupon.status;},'订单核验完成。');
  bind('cashier-checkin-form',async f=>{const r=await api('/api/events/'+encodeURIComponent(v(f,'event_id'))+'/checkins','POST',{member_id:v(f,'member_id'),method:'staff_confirmed'});$('cashier-checkin-result').textContent=tx('签到已记录：','Check-in recorded: ')+r.checkin.id;},'现场核验已完成；不代表成交。');
  page(surface==='staff'?'cashier':surface==='review'?'content':activePage,false);void refresh();
}

