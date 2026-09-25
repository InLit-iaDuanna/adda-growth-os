export const campaignsPage = `<section class="page" id="page-campaigns" hidden>
<p class="eyebrow">02 · Plan and invite</p>
<h1>活动与优惠</h1>
<p class="muted lead">活动先保存草稿并关联已核实的产品与素材；来源链接只携带随机令牌。</p>
<div class="grid">
<div class="card">
<h2>新建活动</h2>
<form id="campaign-form">
<div class="fields"><label>门店<select name="store_id" data-store required></select></label><label>活动名称<input name="name" required maxlength="160"></label><label class="full">活动目标<input name="objective" placeholder="例如：合格订单"></label><label>预算（最小单位）<input name="budget_minor" type="number" min="0" step="1"></label></div>
<div class="actions"><button class="btn">创建草稿</button></div>
</form>
<hr>
<h3>关联产品与素材</h3>
<form id="campaign-resources-form">
<div class="fields"><label class="full">活动<select name="campaign_id" data-campaign required></select></label><label>产品（可多选）<select id="campaign-products" multiple size="3"></select></label><label>素材（可多选）<select id="campaign-assets" multiple size="3"></select></label></div>
<div class="actions"><button class="btn secondary">保存关联</button></div>
</form>
<hr>
<h3>来源链接</h3>
<form id="source-form">
<div class="fields"><label>活动<select name="campaign_id" data-campaign required></select></label><label>来源名称<input name="label" required></label><label>渠道<select name="channel"><option value="manual">人工/线下</option><option value="qr">二维码</option><option value="social">社交平台</option></select></label></div>
<div class="actions"><button class="btn secondary">生成链接</button></div>
</form>
<div id="generated-link" class="output" role="status"></div>
<p class="fine">原始链接只在创建时展示，请立即保存。</p></div>
<div class="card">
<h2>活动列表</h2>
<div id="campaign-list"></div></div></div>
<div class="grid" style="margin-top:14px">
<div class="card">
<h2>创建优惠</h2>
<form id="offer-form">
<div class="fields"><label>活动<select name="campaign_id" data-campaign required></select></label><label>名称<input name="name" required></label><label class="full">条款<textarea name="terms" required></textarea></label><label>有效天数<input name="days" type="number" value="7" min="1" max="365" required></label><label>最大发放量<input name="max_redemptions" type="number" min="1" step="1"></label></div>
<div class="actions"><button class="btn secondary">创建优惠</button></div>
</form></div>
<div class="card">
<h2>优惠列表</h2>
<div id="offer-list"></div></div></div>
</section>`;
