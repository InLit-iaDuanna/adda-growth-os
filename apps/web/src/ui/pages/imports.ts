export const importsPage = `<section class="page" id="page-imports" hidden>
<p class="eyebrow">04 · Evidence first</p>
<h1>POS 与指标</h1>
<p class="muted lead">CSV 先预览错误与来源范围，再人工确认提交。</p>
<div class="grid">
<div class="card">
<h2>导入 CSV</h2>
<form id="import-form">
<div class="fields"><label>门店<select name="store_id" data-store required></select></label><label>类型<select name="kind"><option value="orders">订单</option><option value="refunds">退款</option><option value="members">会员</option></select></label><label>来源标识<input name="source" value="manual_csv" required></label><label>确认完整至<input name="complete_through" type="datetime-local"></label><label class="full">CSV 文件<input id="csv-file" type="file" accept=".csv,text/csv"></label><label class="full">或粘贴 CSV<textarea name="content"></textarea></label></div>
<div class="actions"><button class="btn">预览导入</button><button id="commit-import" class="btn secondary" type="button" disabled>确认提交</button></div>
</form>
<div id="import-preview" class="output" role="status"></div></div>
<div class="card">
<h2>指标质量</h2>
<div id="metric-summary"></div>
<hr>
<h3>导入记录</h3>
<div id="import-list"></div></div></div>
</section>`;
