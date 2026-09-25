export const campusPage = `<section class="page" id="page-campus" hidden>
<p class="eyebrow">06 · On campus</p>
<h1>校园活动</h1>
<p class="muted lead">确认日期和容量，开放报名后才可登记签到。</p>
<div class="grid">
<div class="card">
<h2>活动模板</h2>
<form id="event-form">
<div class="fields"><label>门店<select name="store_id" data-store required></select></label><label>模板<select id="event-template" name="template_id" required></select></label><label>名称<input name="name" required></label><label>容量<input name="capacity" type="number" min="1" required></label><label>开始<input name="starts_at" type="datetime-local"></label><label>结束<input name="ends_at" type="datetime-local"></label></div>
<div class="actions"><button class="btn">创建草稿</button></div>
</form>
<hr>
<h3>补齐草稿日程</h3>
<form id="event-schedule-form">
<div class="fields"><label>活动草稿<select id="schedule-event" name="event_id" required></select></label><label>容量<input name="capacity" type="number" min="1" required></label><label>开始<input name="starts_at" type="datetime-local" required></label><label>结束<input name="ends_at" type="datetime-local" required></label></div>
<div class="actions"><button class="btn secondary">保存日程</button></div>
</form>
<hr>
<h3>报名</h3>
<form id="registration-form">
<div class="fields"><label>校园活动项目<select name="event_id" data-event required></select></label><label>会员 ID<input name="member_id" required></label></div>
<div class="actions"><button class="btn secondary">登记报名</button></div>
</form>
<h3 style="margin-top:17px">签到</h3>
<form id="checkin-form">
<div class="fields"><label>校园活动项目<select name="event_id" data-event required></select></label><label>会员 ID<input name="member_id" required></label></div>
<div class="actions"><button class="btn secondary">确认签到</button></div>
</form></div>
<div class="card">
<h2>校园活动列表</h2>
<div id="event-list"></div>
<hr>
<h3>伙伴资料</h3>
<form id="partner-form">
<div class="fields"><label>名称<input name="name" required></label><label>类型<select name="kind"><option value="organization">机构</option><option value="club">社团</option><option value="koc">KOC</option></select></label><label class="full">公开来源 URL<input name="source_url" type="url" required></label><label class="check full"><input type="checkbox" name="contact_permission">已有联系许可</label></div>
<div class="actions"><button class="btn secondary">登记伙伴</button></div>
</form>
<div id="partner-list"></div></div></div>
</section>`;
