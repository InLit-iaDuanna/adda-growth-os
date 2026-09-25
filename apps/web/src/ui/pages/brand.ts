export const brandPage = `<section class="page" id="page-brand" hidden>
<p class="eyebrow">01 · Source of truth</p>
<h1>品牌与菜单</h1>
<p class="muted lead">品牌事实、价格和素材授权先录入，再明确审批。</p>
<article class="card"><h2>母品牌与子品牌</h2><p class="muted">SUIWU 随物 → ADDA。甲方原图保留原样，界面展示不等于内容营销素材已审批。</p><div class="brand-gallery"><div><a href="/assets/brand/7846e5a3d39a673b230a47f52f4532ca.jpg" target="_blank" rel="noopener"><img loading="lazy" src="/assets/brand/7846e5a3d39a673b230a47f52f4532ca.jpg" alt="SUIWU 英文标识"></a><small>SUIWU 英文标识</small></div><div><a href="/assets/brand/99b0b4ec1602cc2760ffed5944b53444.jpg" target="_blank" rel="noopener"><img loading="lazy" src="/assets/brand/99b0b4ec1602cc2760ffed5944b53444.jpg" alt="SUIWU 随物双语标识"></a><small>SUIWU 随物双语标识</small></div><div><a href="/assets/brand/f78fd9085f6bde2ab8101aac1de72da9.jpg" target="_blank" rel="noopener"><img loading="lazy" src="/assets/brand/f78fd9085f6bde2ab8101aac1de72da9.jpg" alt="SUIWU 品牌场景"></a><small>SUIWU 品牌场景</small></div><div><a href="/assets/brand/4da38778134ae0fc6f4fb0046521903b.jpg" target="_blank" rel="noopener"><img loading="lazy" src="/assets/brand/4da38778134ae0fc6f4fb0046521903b.jpg" alt="水波场景素材"></a><small>水波场景素材</small></div></div></article>
<div class="grid">
<div class="card">
<h2>品牌事实</h2>
<p class="fine">以 JSON 录入已确认资料，例如 {"brand_name":"ADDA TEA"}。提交后仍需审批。</p>
<form id="brand-form">
<div class="fields"><label>来源说明<input name="source_label" value="门店确认" required></label><label>适用门店<select name="store_id" data-store><option value="">整个租户</option></select></label><label class="full">事实 JSON<textarea name="content" required></textarea></label></div>
<div class="actions"><button class="btn">保存待审版本</button></div>
</form>
<hr>
<h3>待补项与版本</h3>
<div id="brand-list"></div></div>
<div class="card">
<h2>菜单产品</h2>
<form id="product-form">
<div class="fields"><label>门店<select name="store_id" data-store required></select></label><label>SKU<input name="external_sku" required></label><label>名称<input name="name" required></label><label>初始价格（最小单位）<input name="price_minor" type="number" min="0" step="1"></label></div>
<div class="actions"><button class="btn">添加产品</button></div>
</form>
<hr>
<div id="product-list"></div>
<h3>添加价格版本</h3>
<form id="price-form">
<div class="fields"><label>产品<select id="price-product" name="product_id" required></select></label><label>价格（最小单位）<input name="amount_minor" type="number" min="0" step="1" required></label><label>状态<select name="status"><option value="draft">待审</option><option value="approved">批准</option></select></label><label>来源<input name="source_citation" value="门店确认" required></label></div>
<div class="actions"><button class="btn secondary">保存价格</button></div>
</form></div></div>
<div class="card" style="margin-top:14px">
<h2>素材授权元数据</h2>
<p class="fine">这里只记录文件路径和授权状态，不上传素材文件。</p>
<form id="asset-form">
<div class="fields"><label>门店<select name="store_id" data-store required></select></label><label>素材路径<input name="storage_key" required></label><label>校验值<input name="checksum" required></label><label>授权状态<select name="rights_status"><option value="unknown">待核验</option><option value="approved">批准</option></select></label><label class="full">授权用途（逗号分隔）<input name="allowed_uses" placeholder="organic_social"></label></div>
<div class="actions"><button class="btn secondary">登记素材</button></div>
</form>
<div id="asset-list"></div></div>
</section>`;
