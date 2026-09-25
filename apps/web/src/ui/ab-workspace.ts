/** A homepage and B run inspector. All mutations use the existing authenticated
 * API callback; no client-side approval or business-state localStorage exists. */
export interface ABBridge {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  page: (name: string) => void;
  can: (permission: string) => boolean;
  snapshot: () => { me: any; health: any; db: Record<string, any>; errors: Record<string, string>; scope?: string };
}
export function installABWorkspace(bridge: ABBridge): { update: () => void } {
  const x = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
  const $ = (id: string): HTMLElement => document.getElementById(id)!;
  const en = (): boolean => document.documentElement.lang === 'en';
  const t = (zh: string, english: string): string => en() ? english : zh;
  const money = (n: unknown): string => typeof n === 'number' && Number.isFinite(n) ? (n / 100).toLocaleString(en() ? 'en' : 'zh-CN', { maximumFractionDigits: 2 }) + ' ' + (bridge.snapshot().me?.stores?.find((s:any)=>s.id===bridge.snapshot().scope)?.currency || 'BDT') : '—';
  const statusName = (s: string): string => (({ queued: t('排队中', 'Queued'), running: t('运行中', 'Running'), completed: t('分析完成', 'Analysis finished'), failed: t('失败', 'Failed'), cancelled: t('已取消', 'Cancelled'), needs_input: t('资料待补', 'Needs input') }) as Record<string, string>)[s] || s;
  const names: Record<string, string> = { brand_guardian: 'Brand Guardian', growth_analyst: 'Growth Analyst', crm_planner: 'CRM Planner', content_producer: 'Content Producer', campus_coordinator: 'Campus Coordinator', event_planner: 'Event Planner', customer_voice: 'Customer Voice' };
  const stat = (label: string, value: unknown, foot: string): string => '<article class="ab-stat"><span>' + x(label) + '</span><strong>' + x(value) + '</strong><small>' + x(foot) + '</small></article>';
  document.body.dataset.workspace = 'ab';
  const home = document.createElement('div'); home.id = 'ab-home'; $('page-overview').prepend(home);
  const nav = document.createElement('button'); nav.type = 'button'; nav.dataset.page = 'orchestration'; nav.className = 'ab-nav';
  nav.innerHTML = '<span class="nav-index" aria-hidden="true">10</span><span class="nav-label">Agent 编排</span><span aria-hidden="true">↗</span>';
  document.querySelector('.nav')!.querySelector('[data-page=overview]')!.after(nav);
  document.querySelectorAll('.nav button[data-page]').forEach((button,index)=>{ const label=button.querySelector('.nav-index');if(label)label.textContent=String(index+1).padStart(2,'0'); });
  const panel = document.createElement('section'); panel.id = 'page-orchestration'; panel.className = 'page ab-orchestration'; panel.hidden = true;
  document.querySelector('#workspace main')!.append(panel);
  let runs: any[] = []; let selected = ''; let nodeIndex = 0; let busy = false; let loaded = false; let loadError = ''; let message = ''; let owner = ''; let generation = 0;
  const btn = (action: string, label: string, id = '', disabled = false): string => '<button type="button" class="ab-button" data-ab-action="' + action + '" data-ab-id="' + x(id) + '"' + (disabled ? ' disabled' : '') + '>' + x(label) + '</button>';
  function openRuns(): void { bridge.page('orchestration'); if (!loaded && !busy) void reload(); else renderRuns(); }
  nav.addEventListener('click', openRuns);
  function renderHome(): void {
    const { db, errors, health, me, scope } = bridge.snapshot();
    const store = (me?.stores || []).find((s:any)=>s.id===scope);
    const fail = (key: string): boolean => Boolean(errors[key]) || !bridge.can(key === 'content' ? 'campaign:read' : 'report:read');
    const content = db.content?.items || [];
    const pending = content.filter((c: any) => ['draft', 'pending_approval', 'needs_local_review'].includes(c.status));
    const cases = (db.cases?.items || []).filter((c: any) => !['resolved', 'closed'].includes(c.status));
    const tasks = db.daily?.tasks || [];
    const m = db.metrics?.summary;
    const metricsReason = fail('metrics') ? t('未能读取，不能视作零', 'Unavailable, not zero') : t('来自指标接口；缺失保留空值', 'From metrics API; missing stays null');
    home.innerHTML = '<div class="ab-home-top"><div><p class="ab-kicker">ADDA / GROWTH WORKSPACE</p><h1>' + t('增长驾驶舱', 'Growth workspace') + '</h1><p>' + t('先看证据，再决定下一步。当前展示所选门店的数据。', 'Evidence first, then the next action. Data covers your authorized scope.') + '</p></div><div>' + btn('open-runs', t('进入 Agent 编排 ↗', 'Open orchestration ↗')) + '</div></div>' +
      '<div class="ab-context"><span>● ' + x(health?.mode || 'unknown') + '</span><span>' + t('指标不等于因果 · 分析不等于发布', 'Metrics are not causality · Analysis is not publication') + '</span><span>' + x(store ? store.name + ' · ' + store.timezone + ' · ' + store.currency : t('授权门店汇总', 'Authorized stores')) + '</span></div>' +
      '<div class="ab-stats">' + stat(t('合格订单', 'Qualified orders'), fail('metrics') ? '—' : m?.qualified_order_count ?? '—', metricsReason) + stat(t('净营收', 'Net revenue'), fail('metrics') ? '—' : money(m?.net_revenue_minor), metricsReason) + stat(t('内容待审', 'Content to review'), fail('content') ? '—' : pending.length, fail('content') ? t('未读取', 'Not loaded') : t('草稿 / 审批 / 本地复核', 'Draft / approval / local review')) + stat(t('反馈待办', 'Open feedback cases'), fail('cases') ? '—' : cases.length, fail('cases') ? t('未读取', 'Not loaded') : t('未关闭工单', 'Cases not closed')) + '</div>' +
      '<div class="ab-home-grid"><article class="ab-card"><div class="ab-card-head"><div><p class="ab-kicker">REQUIRES YOUR DECISION</p><h2>' + t('今天先处理什么', 'What needs attention') + '</h2></div><span class="ab-tag">' + t('人工决策', 'Human decision') + '</span></div>' +
      (fail('content') ? '<p class="ab-error">' + t('内容队列读取失败或无权限，不展示虚假的零待办。', 'Content queue is unavailable or forbidden; it is not an empty queue.') + '</p>' : pending.slice(0, 4).map((c: any) => '<div class="ab-task"><span class="ab-task-icon">↗</span><div><strong>' + x(c.title || c.content_pillar || c.id) + '</strong><small>' + x(c.status) + ' · ' + t('使用原内容审批链路', 'Uses the existing approval workflow') + '</small></div>' + btn('content', t('审阅', 'Review')) + '</div>').join('') || '<p class="ab-empty">' + t('当前没有待审内容。创建活动后，在内容审批中生成草稿。', 'No content awaiting review. Create a campaign before generating drafts.') + '</p>') +
      '<div class="ab-home-actions">' + btn('campaigns', t('新建活动', 'New campaign')) + btn('imports', t('核对 POS 与指标', 'Review POS and metrics')) + '</div></article>' +
      '<aside class="ab-card ab-next"><p class="ab-kicker">CONTROLLED EXECUTION</p><h2>' + t('每一步，都可追溯', 'Every step is traceable') + '</h2><p>' + t('只读技能 → 持久化检查点 → 人工审阅。外发、触达和孟语复核继续使用原业务审批。', 'Read-only skills → persisted checkpoints → human review. Dispatch and Bengali review keep their existing approval controls.') + '</p><div class="ab-flow-mini"><span>01 · Scope</span><span>02 · Evidence</span><span>03 · Review</span></div>' + btn('open-runs', t('打开运行队列 →', 'Open run queue →')) + '</aside></div>' +
      '<div class="ab-home-grid"><article class="ab-card"><h2>' + t('行动任务', 'Action tasks') + '</h2>' + (fail('daily') ? '<p class="ab-error">' + t('任务数据未读取', 'Task data unavailable') + '</p>' : tasks.filter((a: any) => a.status !== 'done').slice(0, 3).map((a: any) => '<div class="ab-task"><div><strong>' + x(a.title) + '</strong><small>' + x(a.status) + '</small></div>' + btn('control', t('查看证据', 'View evidence')) + '</div>').join('') || '<p class="ab-empty">' + t('暂无行动任务。', 'No action tasks.') + '</p>') + '</article><article class="ab-card"><h2>' + t('来源与连接器', 'Sources and connectors') + '</h2>' + Object.entries(health?.connectors || {}).map(([key, value]: [string, any]) => '<div class="ab-connector"><strong>' + x(key) + '</strong><span>' + x(value.mode) + '</span></div>').join('') + '<small>' + t('未配置渠道不会显示为已接通。', 'Unconfigured channels never appear connected.') + '</small></article></div>';
  }
  function renderRuns(): void {
    const chosen = runs.find(r => r.id === selected) || runs[0];
    if (chosen && !selected) selected = chosen.id;
    const nodes = chosen?.nodes || [];
    if (nodeIndex >= nodes.length) nodeIndex = 0;
    const node = nodes[nodeIndex];
    const authorized = bridge.can('report:read');
    const focused = panel.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.abAction : undefined;
    panel.innerHTML = '<div class="ab-run-header"><div><p class="ab-kicker">ADDA / RELAY</p><h1>' + t('Agent 编排', 'Agent orchestration') + '</h1><p>' + t('服务端检查点 · 确定性离线技能 · 外部写入禁用', 'Server checkpoints · Deterministic offline skills · External writes disabled') + '</p></div><div class="ab-run-actions">' + btn('reload', t('刷新', 'Refresh'), '', busy || !authorized) + btn('new', t('+ 新建任务', '+ New run'), '', busy || !authorized) + '</div></div>' +
      '<div class="ab-run-message" role="status">' + x(loadError || message || (loaded ? t('展示当前用户最近 100 条授权任务。', 'Showing your latest 100 authorized runs.') : t('尚未读取任务。', 'Runs have not been loaded.'))) + '</div>' +
      '<div class="ab-console"><aside class="ab-queue"><div class="ab-console-label">RUN QUEUE <span>' + (loaded && !loadError ? runs.length : '—') + '</span></div>' + (runs.map(r => '<button class="ab-run-item' + (r.id === selected ? ' is-selected' : '') + '" data-ab-action="select" data-ab-id="' + x(r.id) + '"><span>' + x(r.plan.toUpperCase()) + ' · v' + x(r.version) + '</span><strong>' + x(r.prompt.slice(0, 75)) + '</strong><small>' + x(statusName(r.status)) + ' · ' + x(r.storeId) + '</small></button>').join('') || '<p class="ab-empty">' + (loadError ? t('读取失败，不能判定队列为空。', 'Read failed; queue emptiness is unknown.') : t('创建一个有明确门店范围的检查任务。', 'Create a check with an explicit store scope.')) + '</p>') + '</aside><div class="ab-canvas"><div class="ab-console-label">' + t('执行图 / 顺序检查点', 'EXECUTION / SEQUENTIAL CHECKPOINTS') + '<span>READ ONLY</span></div>' +
      (chosen ? '<div class="ab-run-title"><h2>' + x(chosen.prompt) + '</h2><p>' + x(chosen.id) + ' · v' + x(chosen.version) + '</p></div><div class="ab-nodes">' + nodes.map((n: any, i: number) => '<button class="ab-node' + (i === nodeIndex ? ' is-selected' : '') + '" data-ab-node="' + i + '"><span class="ab-node-index">' + String(i + 1).padStart(2, '0') + '</span><strong>' + x(names[n.skill] || n.skill) + '</strong><small class="ab-state-' + x(n.status) + '">' + x(statusName(n.status)) + '</small><small>' + t('尝试 ', 'Attempt ') + x(n.attempts) + ' · ' + x(n.result?.status || n.error || 'not_started') + '</small></button>').join('') + '</div>' +
        '<div class="ab-run-controls">' + btn('advance', t('推进下一步', 'Advance one step'), chosen.id, busy || chosen.execution === 'background' || !['queued', 'running'].includes(chosen.status) || !!loadError) + btn('retry', t('仅重试失败节点', 'Retry failed node'), chosen.id, busy || chosen.status !== 'failed' || !chosen.nodes.some((n:any)=>n.status==='failed' && n.error==='analysis_failed' && n.attempts<=chosen.maxRetries) || !!loadError) + btn('cancel', t('取消任务', 'Cancel run'), chosen.id, busy || ['completed', 'cancelled'].includes(chosen.status) || !!loadError) + btn('export', t('导出记录', 'Export record'), chosen.id, !!loadError) + '</div>' +
        '<div class="ab-conclusion"><strong>' + t('执行状态', 'Execution') + ': ' + x(statusName(chosen.status)) + '</strong><span>' + t('业务结论', 'Business conclusion') + ': ' + x(chosen.conclusion) + '</span><p>' + t('分析完成不表示增长有效，也不表示任何内容已获准发布。', 'Finished analysis proves neither growth impact nor publication approval.') + '</p></div><div class="ab-event-log"><div class="ab-console-label">EVENT LOG</div>' + chosen.events.slice(-6).map((e: any) => '<div><time>' + x(new Date(e.at).toLocaleTimeString(en() ? 'en' : 'zh-CN', { timeZone: 'Asia/Dhaka' })) + '</time><span>' + x(e.type) + (e.node !== null ? ' · #' + (e.node + 1) : '') + '</span></div>').join('') + '</div>' : '<div class="ab-canvas-empty"><strong>' + t('一个任务，一条可核对的执行链。', 'One run. An auditable execution chain.') + '</strong><p>' + t('任务保存在后端，不依赖此标签页或本地缓存。', 'Runs live on the server, not in this tab or local cache.') + '</p></div>') +
      '</div><aside class="ab-inspector"><div class="ab-console-label">INSPECTOR</div><h3>' + x(node ? names[node.skill] : t('节点详情', 'Node details')) + '</h3>' +
      (chosen ? '<dl><dt>' + t('模型成本', 'Model cost') + '</dt><dd>' + money(chosen.actualCostMinor) + '</dd><dt>' + t('预算上限', 'Budget cap') + '</dt><dd>' + money(chosen.budgetMinor) + '</dd><dt>' + t('外部写入', 'External writes') + '</dt><dd>DISABLED</dd><dt>' + t('固定数据时点', 'Pinned as-of') + '</dt><dd>' + x(chosen.asOf) + '</dd></dl>' : '') +
      (node?.error ? '<p class="ab-error">' + x(node.error) + '</p>' : '') + (node?.result ? '<div class="ab-observations">' + node.result.observations.map((o: any) => '<p>' + x(o.text) + '<small>' + x(o.sourceRefs.join(', ')) + '</small></p>').join('') + '<h4>' + t('仍需补充', 'Still required') + '</h4><p>' + x((node.result.needsInput || []).join(' · ') || '—') + '</p></div>' : '<p>' + t('选择节点查看实际输出与缺失原因。', 'Select a node to inspect outputs and missing inputs.') + '</p>') + btn('content', t('前往内容审批 →', 'Open content review →')) + '</aside></div>';
    if (focused) panel.querySelector<HTMLElement>('[data-ab-action="' + focused + '"]')?.focus({preventScroll:true});
  }
  async function reload(): Promise<void> {
    if (!bridge.can('report:read')) { runs = []; loaded = false; loadError = t('没有读取编排的权限。', 'No permission to read runs.'); renderRuns(); return; }
    const epoch = generation; busy = true; if (!loaded) renderRuns();
    try { const result = await bridge.api('/api/control/runs'); if (epoch !== generation) return; if (!Array.isArray(result.items)) throw new Error('invalid_run_response'); runs = result.items; if (!runs.some(r => r.id === selected)) selected = runs[0]?.id || ''; loaded = true; loadError = ''; }
    catch (error) { if (epoch === generation) { loadError = t('任务读取失败：', 'Run read failed: ') + String(error instanceof Error ? error.message : error); runs = []; loaded = false; } }
    finally { if (epoch === generation) { busy = false; renderRuns(); } }
  }
  function newRun(): void {
    const epoch = generation;
    const dialog = document.createElement('dialog'); dialog.className = 'ab-dialog';
    const stores: string[] = (bridge.snapshot().me?.store_ids || []).filter((id:string)=>!bridge.snapshot().scope || id===bridge.snapshot().scope);
    dialog.innerHTML = '<form><div class="ab-card-head"><h2>' + t('新建只读检查', 'New read-only check') + '</h2><button type="button" data-close aria-label="Close">×</button></div><p>' + t('不会生成发布授权，也不会调用外部渠道。', 'No publication authorization or external channel call is created.') + '</p><label>' + t('任务目标', 'Objective') + '<textarea name="prompt" required maxlength="4000" rows="3"></textarea></label><label>' + t('门店范围', 'Store scope') + '<select name="store" required>' + stores.map(s => '<option>' + x(s) + '</option>').join('') + '</select></label><label>' + t('检查流程', 'Check plan') + '<select name="plan"><option value="growth">Growth / 品牌 → 指标 → CRM</option><option value="content">Content / 品牌 → 内容</option><option value="campus">Campus / 伙伴 → 活动</option><option value="voice">Voice / 反馈 → 指标</option></select></label><label>' + t('执行方式','Execution mode') + '<select name="execution"><option value="background">后台执行 / Background worker</option><option value="manual">逐步调试 / Step-by-step</option></select></label><p>' + t('离线模型成本 0 BDT；上限 180 秒；失败最多重试一次。', 'Offline model cost 0 BDT; 180-second deadline; one retry per failed node.') + '</p><p class="ab-error" role="status"></p><button class="ab-button" type="submit">' + t('创建任务', 'Create run') + '</button></form>';
    document.body.append(dialog); const trigger = document.activeElement as HTMLElement;
    const close = (): void => { dialog.close(); dialog.remove(); trigger?.focus(); };
    dialog.querySelector('[data-close]')!.addEventListener('click', close); dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
    // Reuse the same key after an uncertain POST result: it is not a new run.
    const requestKey = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
    let request: Record<string, unknown> | null = null;
    dialog.querySelector('form')!.addEventListener('submit', async e => {
      e.preventDefault(); if (busy) return;
      const form = dialog.querySelector('form')!; const data = new FormData(form);
      request ??= { execution: data.get('execution') || 'background', prompt: data.get('prompt'), plan: data.get('plan'), store_id: data.get('store'), request_key: requestKey, budget_minor: 0, max_retries: 1, deadline_seconds: 180 };
      busy = true; const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!; submit.disabled = true;
      form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select').forEach(field => { field.disabled = true; });
      try { const result = await bridge.api('/api/control/runs', 'POST', request); if (epoch !== generation) return; selected = result.item.id; message = t('任务已保存。后台模式由 worker 执行，离开页面也不会丢失。', 'Run saved. Background mode is processed by the worker, independently of this tab.'); close(); busy = false; await reload(); panel.querySelector<HTMLElement>('[data-ab-action=new]')?.focus(); }
      catch (error) { if (epoch !== generation) return; form.querySelector('[role=status]')!.textContent = String(error instanceof Error ? error.message : error) + t('。重试会复用本次任务键；修改目标请关闭后新建。', '. Retry reuses this request key; close and reopen to change the objective.'); }
      finally { if (epoch === generation) { busy = false; submit.disabled = false; } }
    });
    dialog.showModal(); dialog.querySelector('textarea')?.focus();
  }
  async function action(name: string, id: string): Promise<void> {
    if (name === 'open-runs') { openRuns(); return; }
    if (['content', 'campaigns', 'imports', 'control'].includes(name)) { bridge.page(name); return; }
    if (name === 'select') { selected = id; nodeIndex = 0; renderRuns(); return; }
    if (name === 'reload') { await reload(); return; }
    if (name === 'new') { if (!busy && bridge.can('report:read')) newRun(); return; }
    let run = runs.find(r => r.id === id); if (!run || loadError) return;
    if (name === 'export') {
      try { run = (await bridge.api('/api/control/runs/' + encodeURIComponent(id))).item; } catch { message=t('导出前权限复核失败，请刷新。','Export authorization failed. Refresh before retrying.'); renderRuns(); return; }
      const url = URL.createObjectURL(new Blob([JSON.stringify({ source: 'authenticated_server_checkpoint', run }, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'adda-run-' + run.id + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
    }
    if (busy || !['advance', 'retry', 'cancel'].includes(name)) return;
    const epoch = generation; busy = true; renderRuns();
    try {
      const result = await bridge.api('/api/control/runs/' + encodeURIComponent(id) + '/' + name, 'POST', { expected_version: run.version });
      if (epoch !== generation) return;
      runs = runs.map(r => r.id === id ? result.item : r);
      message = result.item.status === 'failed' ? t('节点失败，未宣称执行成功；请查看错误。', 'Node failed; inspect the error. This is not a successful execution.') : t('服务端检查点已保存。', 'Server checkpoint saved.');
    } catch (error) {
      // An uncertain response never causes a blind replay of the command.
      if (epoch !== generation) return;
      message = String(error instanceof Error ? error.message : error) + t('；已重新读取服务端状态，没有自动重放。', '; reloading server state without replay.');
      await reload();
    } finally { if (epoch === generation) { busy = false; renderRuns(); } }
  }
  for (const target of [home, panel]) target.addEventListener('click', event => {
    const element = (event.target as Element).closest<HTMLElement>('[data-ab-action],[data-ab-node]'); if (!element) return;
    if ('abNode' in element.dataset) { nodeIndex = Number(element.dataset.abNode); renderRuns(); return; }
    void action(element.dataset.abAction!, element.dataset.abId || '');
  });
  setInterval(() => { if (!panel.hidden && owner && !busy && !document.hidden && !document.querySelector('dialog[open]')) void reload(); }, 2000);
  return { update(): void {
    const snapshot = bridge.snapshot(); const nextOwner = snapshot.me ? JSON.stringify([snapshot.me.user.id, snapshot.me.actor?.tenant_id || snapshot.me.tenant_id || '', snapshot.me.role, snapshot.me.store_ids, snapshot.scope]) : '';
    if (nextOwner !== owner) { document.querySelectorAll<HTMLDialogElement>('.ab-dialog').forEach(d => { d.close(); d.remove(); }); generation++; owner = nextOwner; runs = []; selected = ''; loaded = false; busy = false; loadError = ''; message = ''; }
    if (!snapshot.me) { home.replaceChildren(); panel.replaceChildren(); return; }
    nav.hidden = !bridge.can('report:read') || document.body.dataset.surface !== 'admin';
    renderHome(); renderRuns();
    for (const [key, id] of Object.entries({ content: 'content-list', cases: 'case-list', daily: 'daily-list', imports: 'import-list', outreach: 'outreach-list', campaigns: 'campaign-list' })) {
      const target = document.getElementById(id); if (target && snapshot.errors[key]) target.innerHTML = '<p class="ab-error" role="status">' + x(snapshot.errors[key]) + '</p>';
    }
  } };
}
