export const controlPage = `<section class="page" id="page-control" hidden>
<p class="eyebrow">08 · Review and operate</p>
<h1>日报与连接器</h1>
<p class="muted lead">日报标出数据质量；人工导出与真实外部发送分别显示。</p>
<div class="grid">
<div class="card">
<h2>日报</h2><button id="generate-report" class="btn">生成今天的日报</button>
<div id="daily-list"></div>
<div id="daily-detail" class="output" role="region" aria-label="日报详情"></div>
<hr>
<h3>任务</h3>
<div id="task-list"></div>
<form id="task-form">
<div class="fields"><label>我的任务<select id="task-select" name="task_id" required></select></label><label>完成证据<input name="evidence" required></label></div>
<div class="actions"><button class="btn secondary">记录完成</button></div>
</form></div>
<div class="card">
<h2>连接器状态</h2>
<div id="connector-list"></div></div></div>
</section>`;
