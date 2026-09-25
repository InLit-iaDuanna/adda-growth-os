export const voicePage = `<section class="page" id="page-voice" hidden>
<p class="eyebrow">07 · Close the loop</p>
<h1>顾客反馈</h1>
<p class="muted lead">记录、处理、审批回复并留存人工执行证据。</p>
<div class="grid">
<div class="card">
<h2>登记反馈</h2>
<form id="feedback-form">
<div class="fields"><label>门店<select name="store_id" data-store required></select></label><label>来源<input name="source" value="staff_recorded" required></label><label class="full">顾客原话<textarea name="text" required></textarea></label></div>
<div class="actions"><button class="btn">保存反馈</button></div>
</form>
<hr>
<h3>反馈列表</h3>
<div id="feedback-list"></div></div>
<div class="card">
<h2>工单与回复</h2>
<div id="case-list"></div>
<hr>
<form id="reply-form">
<div class="fields"><label>工单<select id="reply-case" name="case_id" required></select></label><label>方式<select name="channel"><option value="manual">人工</option><option value="email">Email</option><option value="sms">SMS</option></select></label><label class="full">回复文案<textarea name="body" required></textarea></label></div>
<div class="actions"><button class="btn secondary">保存回复草稿</button></div>
</form>
<div id="reply-list"></div>
<hr>
<h3>人工任务</h3>
<div id="voice-task-list"></div>
<form id="voice-task-form">
<div class="fields"><label>我的任务<select id="voice-task-select" name="task_id" required></select></label><label class="full">完成证据<input name="evidence" required minlength="3"></label></div>
<div class="actions"><button class="btn secondary">记录人工处理</button></div>
</form>
<hr>
<h3>结案</h3>
<form id="case-resolve-form">
<div class="fields"><label>工单<select id="resolve-case" name="case_id" required></select></label><label class="full">结案证据<input name="evidence" required minlength="3"></label></div>
<div class="actions"><button class="btn secondary">结案并留存证据</button></div>
</form></div></div>
</section>`;
