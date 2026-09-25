export const contentPage = `<section class="page" id="page-content" hidden>
<p class="eyebrow">03 · Review before use</p>
<h1>内容审批</h1>
<p class="muted lead">逐语种审阅、孟语复核和审批后才能导出；导出不代表发布。</p>
<div class="grid">
<div class="card">
<h2>生成内容草稿</h2>
<form id="content-form">
<div class="fields"><label>活动<select name="campaign_id" data-campaign required></select></label><label>渠道<select name="channel"><option value="manual">人工发布</option><option value="instagram">Instagram</option><option value="facebook">Facebook</option></select></label><label>内容支柱<input name="content_pillar" value="Campus Adda"></label><label>目标指标<input name="target_metric" value="verified_orders"></label></div>
<div class="actions"><button class="btn">生成草稿</button></div>
</form>
<p class="fine">演示环境使用确定性样例提供者。</p></div>
<div class="card">
<h2>内容详情</h2>
<div id="content-detail" class="output" role="region" aria-label="内容详情"></div></div></div>
<div class="card" style="margin-top:14px">
<h2>版本队列</h2>
<div id="content-list"></div></div>
</section>`;
