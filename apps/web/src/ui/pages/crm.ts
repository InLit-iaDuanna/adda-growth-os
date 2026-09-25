export const crmPage = `<section class="page" id="page-crm" hidden>
<p class="eyebrow">05 · Consent and guardrails</p>
<h1>会员触达</h1>
<p class="muted lead">按规则预览受众、冻结名单，再审批模板和预算。无连接器时发送会被阻断。</p>
<div class="grid">
<div class="card">
<h2>预览分群</h2>
<form id="segment-form">
<div class="fields"><label>门店<select name="store_id" data-store required></select></label><label>规则<select name="rule"><option value="registered_unpurchased">已注册未首购</option><option value="first_purchase_no_second">首购未复购</option><option value="inactive_14d">14 天未活跃</option><option value="marketing_opt_in">同意营销</option></select></label></div>
<div class="actions"><button class="btn secondary">查看人数</button></div>
</form>
<div id="segment-preview" class="output"></div>
<hr>
<h2>创建触达任务</h2>
<form id="outreach-form">
<div class="fields"><label>门店<select name="store_id" data-store required></select></label><label>规则<select name="rule"><option value="registered_unpurchased">已注册未首购</option><option value="first_purchase_no_second">首购未复购</option><option value="inactive_14d">14 天未活跃</option><option value="marketing_opt_in">同意营销</option></select></label><label>任务名称<input name="name" required></label><label>渠道<select name="channel"><option value="manual">人工</option><option value="email">Email</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option></select></label><label>模板 ID<input name="template_id" required></label><label>预算（最小单位）<input name="budget_minor" type="number" min="0" value="0" required></label><label class="full">模板文案<textarea name="template_text" required></textarea></label><label>保留组 %<input name="holdout_percent" type="number" min="0" max="100" value="10"></label><label class="check"><input name="template_approved" type="checkbox">我已核实模板</label></div>
<div class="actions"><button class="btn">冻结受众并创建</button></div>
</form></div>
<div class="card">
<h2>触达队列</h2>
<div id="outreach-list"></div></div></div>
</section>`;
