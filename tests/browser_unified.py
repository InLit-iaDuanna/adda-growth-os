"""Run the real application's browser checks against an isolated synthetic HTTP DB.

Default: native navigation and browser cookies (normal Playwright E2E).
--dom-harness: for environments prohibiting navigation. Load the server's HTML
in memory and forward fetch through an isolated Python HTTP cookie jar. Embed
unchanged local image bytes. Does NOT verify browser cookies, origin storage,
redirects, CSP or native navigation, and is reported separately from E2E.
No API success or business payload is mocked. --dom-harness never alters the
application's source code or Chromium policy.

Prerequisites: npm run build; pip install playwright requests; Chromium.
"""
from __future__ import annotations
import argparse, base64, datetime, json, mimetypes, re, subprocess, sys, time
from pathlib import Path
from urllib.parse import urlsplit
import requests
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--dom-harness', action='store_true')
parser.add_argument('--chromium', default='/usr/bin/chromium')
parser.add_argument('--output', default='artifacts/unified-2026-09-25/browser-checks.json')
args = parser.parse_args()
OUTPUT = ROOT / args.output
SHOTS = OUTPUT.parent / 'screenshots'
SHOTS.mkdir(parents=True, exist_ok=True)
checks: list[dict] = []
fixture = subprocess.Popen(['node', 'dist/tests/unified-fixture.js'], cwd=ROOT,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
line = fixture.stdout.readline()
if not line:
    raise RuntimeError('Fixture did not start: ' + fixture.stderr.read())
f = json.loads(line)
base = f['baseUrl']


def record(name: str, passed: bool = True, detail=None):
    checks.append({'name': name, 'passed': bool(passed), 'detail': detail})
    if not passed:
        raise AssertionError(name + ': ' + str(detail))


class Surface:
    def __init__(self, browser, path='/', width=1500):
        self.context = browser.new_context(viewport={'width': width, 'height': 1000})
        self.page = self.context.new_page()
        self.page.set_default_timeout(8000)
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.http = requests.Session()
        self.calls = []
        self.fail_reads: set[str] = set()
        if args.dom_harness:
            self.page.expose_function('__httpUnderTest', self.forward)
        self.load(path)

    def forward(self, request):
        url = str(request['url'])
        if url.startswith(base):
            url = url[len(base):]
        if not url.startswith('/api/'):
            raise ValueError('Test bridge only accepts the local application /api/')
        method = request.get('method', 'GET')
        if urlsplit(url).path in self.fail_reads and method == 'GET':
            # Explicit fault injection only. Never a fabricated successful response.
            return {'body': '{"error_code":"qa_read_failure"}', 'status': 503,
                    'headers': {'content-type': 'application/json'}}
        r = self.http.request(method, base + url, headers=request.get('headers', {}),
                              data=request.get('body'), timeout=15)
        self.calls.append({'method': method, 'path': urlsplit(url).path, 'status': r.status_code})
        return {'body': r.text, 'status': r.status_code,
                'headers': {'content-type': r.headers.get('content-type', 'text/plain')}}

    def load(self, path):
        if not args.dom_harness:
            self.page.goto(base + path)
            return
        html = self.http.get(base + path, timeout=15).text
        # about:blank has no URL origin. Substitute only this environment value
        # in the in-memory test copy; all production URL handling stays intact.
        html = html.replace('new URL(path, location.origin)',
                            'new URL(path, ' + json.dumps(base) + ')')

        def image_bytes(match):
            image = ROOT / 'apps/web/public' / match.group(0)[1:]
            mime = mimetypes.guess_type(str(image))[0]
            return 'data:' + str(mime) + ';base64,' + base64.b64encode(image.read_bytes()).decode()
        html = re.sub(r'/assets/brand/[\w.-]+\.(?:png|jpg)', image_bytes, html)
        shim = '''<script>window.fetch=async function(url, options={}) {
          const r=await window.__httpUnderTest({url:String(url),method:options.method||'GET',
             headers:options.headers||{},body:options.body});
          return new Response(r.body,{status:r.status,headers:r.headers});
        };</script>'''
        html = html.replace('<script>', shim + '<script>', 1)
        self.page.evaluate("history.replaceState(null,'','#')")
        self.page.set_content(html, wait_until='load')
        self.page.wait_for_timeout(300)

    def login(self, role='owner'):
        self.page.locator('#email').fill(role + '@demo.adda.local')
        self.page.locator('#password').fill('demo-only-password')
        self.page.locator('#login-form button').click()
        expect(self.page.locator('#workspace')).to_be_visible()
        self.page.wait_for_timeout(700)
        record(role + ' real login and scoped render', not self.errors, self.errors.copy())

    def go(self, name):
        nav = self.page.locator('.nav button[data-page="' + name + '"]')
        if not nav.is_visible():
            self.page.locator('#nav-toggle').click()
        nav.click()
        expect(self.page.locator('#page-' + name)).to_be_visible()
        self.page.wait_for_timeout(160)

    def fits(self, name):
        dimensions = self.page.evaluate('''() => ({ viewport:innerWidth,
          scroll:document.documentElement.scrollWidth,
          body:document.body.scrollWidth })''')
        record(name + ' no horizontal page overflow',
               max(dimensions['scroll'], dimensions['body']) <= dimensions['viewport'] + 1, dimensions)

    def screenshot(self, name):
        self.page.screenshot(path=str(SHOTS / (name + '.png')), full_page=True)

    def api(self, path, method='GET', data=None):
        if args.dom_harness:
            me = self.http.get(base+'/api/me', timeout=15).json()
            return self.http.request(method, base+path, json=data,
                  headers={'x-csrf-token': me.get('csrf_token','')}, timeout=15)
        csrf = self.context.request.get(base+'/api/me').json().get('csrf_token','')
        return self.context.request.fetch(base+path, method=method, data=data,
                                         headers={'x-csrf-token':csrf})


error = None
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=args.chromium, headless=True,
                                    args=['--no-sandbox'])
        admin = Surface(browser)
        admin.screenshot('login-desktop')
        admin.login()
        admin.go('overview'); admin.screenshot('home-desktop')
        record('homepage has real campaign name, not a bare UUID',
               'QA 合成活动' in admin.page.locator('#ab-home').inner_text())
        admin.go('orchestration')
        admin.page.locator('[data-ab-action=new]').click()
        expect(admin.page.locator('dialog')).to_be_visible()
        record('new-run modal takes focus', admin.page.evaluate("document.activeElement.name==='prompt'"))
        admin.page.keyboard.press('Escape')
        expect(admin.page.locator('dialog')).to_have_count(0)
        record('Escape closes modal and restores focus',
               admin.page.evaluate("document.activeElement.dataset.abAction==='new'"))
        admin.page.locator('[data-ab-action=new]').click()
        admin.page.locator('dialog [name=prompt]').fill('核对已批准品牌与内容，交给人工复核')
        admin.page.locator('dialog [name=plan]').select_option('content')
        admin.page.locator('dialog button[type=submit]').click()
        expect(admin.page.locator('dialog')).to_have_count(0)
        expect(admin.page.locator('.ab-conclusion strong')).to_contain_text('分析完成',timeout=10000)
        record('UI-created background task completes through real persistent worker')
        admin.screenshot('orchestration-desktop')
        record('background run cannot be advanced by UI step button',
               admin.page.locator('[data-ab-action=advance]').is_disabled())
        admin.load('/admin'); admin.go('orchestration')
        expect(admin.page.locator('.ab-conclusion strong')).to_contain_text('分析完成')
        record('new document reload recovers saved server run')
        admin.page.locator('#lang-en').click()
        expect(admin.page.locator('#page-orchestration h1')).to_have_text('Agent orchestration')
        record('orchestration switches to English')
        admin.page.locator('#lang-zh').click()

        pages=['overview','orchestration','content','imports','brand','campaigns','crm','campus','voice','control','cashier']
        for width in [1500,1024,768,390,360]:
            admin.page.set_viewport_size({'width':width,'height':950})
            for name in pages:
                admin.go(name);admin.fits(f'{name}/{width}')
            if width==390:
                admin.go('overview');admin.screenshot('home-mobile')
                admin.go('orchestration');admin.screenshot('orchestration-mobile')
        record('all management views have no browser JavaScript errors', not admin.errors, admin.errors)
        admin.page.set_viewport_size({'width':1500,'height':1000})
        admin.go('brand');admin.screenshot('brand-desktop')
        admin.go('content')
        admin.page.locator('[data-action=content-view]').first.click()
        expect(admin.page.locator('#content-detail')).to_contain_text('Synthetic test product')
        admin.screenshot('content-desktop')
        admin.page.locator('[data-action=content-edit]').first.click()
        expect(admin.page.locator('dialog')).to_be_visible()
        admin.page.locator('dialog [name=notes]').fill('QA 改稿：只用于合成回归，不代表甲方确认。')
        admin.page.locator('dialog button[type=submit]').click()
        expect(admin.page.locator('dialog')).to_have_count(0)
        expect(admin.page.locator('#notice')).to_contain_text('已保存新稿')
        record('editor saves with expected hash; old local review reset')

        reviewer=Surface(browser,'/review');reviewer.login('reviewer')
        expect(reviewer.page.locator('#page-content')).to_be_visible()
        record('review surface removes generation and owner approval controls',
               not reviewer.page.locator('#content-form').is_visible() and
               reviewer.page.locator('[data-action=content-approve]').count()==0)
        reviewer.page.locator('[data-action=content-review]').first.click()
        reviewer.page.wait_for_timeout(600)
        record('local reviewer completes Bengali review via existing API')
        reviewer.screenshot('review-desktop')
        reviewer.page.set_viewport_size({'width':390,'height':900});reviewer.fits('review/390');reviewer.screenshot('review-mobile')

        admin.load('/admin');admin.go('content')
        admin.page.locator('[data-action=content-submit]').first.click()
        expect(admin.page.locator('[data-action=content-approve]').first).to_be_visible()
        admin.page.locator('[data-action=content-approve]').first.click()
        expect(admin.page.locator('[data-action=content-export]').first).to_be_visible()
        record('Bengali review -> submit -> owner approve through real backend')
        admin.page.locator('[data-action=content-history]').first.click()
        expect(admin.page.locator('#content-detail')).to_contain_text('approved')
        record('UI exposes immutable approved history')
        # Create a separate approval to exercise rejection without weakening tests.
        result=admin.api('/api/content/generate','POST',{'campaign_id':f['campaignId'],'channel':'manual'})
        revision=result.json()['revision']['id']
        admin.api('/api/content/'+revision+'/review-bn','POST',{'decision':'reviewed'})
        admin.api('/api/content/submit','POST',{'revision_id':revision})
        admin.load('/admin');admin.go('content')
        admin.page.locator('[data-action=content-reject]').first.click()
        admin.page.locator('dialog [name=reason]').fill('QA: correction required before use')
        admin.page.locator('dialog button[type=submit]').click()
        expect(admin.page.locator('dialog')).to_have_count(0)
        expect(admin.page.locator('#content-list')).to_contain_text('rejected')
        record('rejection dialog persists reason and removes pending approval')

        consumer=Surface(browser,f['sourceUrl'],width=390)
        record('marketing consent is unchecked by default', not consumer.page.locator('#optin').is_checked())
        consumer.fits('consumer/390');consumer.screenshot('consumer-mobile')
        consumer.page.locator('#contact').fill('browser-synthetic@example.invalid')
        consumer.page.locator('#optin').check()
        consumer.page.locator('#channel').select_option('email')
        consumer.page.locator('#join-button').click()
        expect(consumer.page.locator('#verify-step')).to_be_visible()
        member_id=re.search(r'ID: ([\w-]+)',consumer.page.locator('#result').inner_text()).group(1)
        record('consumer registers through real API; no repeated form')
        consumer.page.locator('#code').fill('000000');consumer.page.locator('#verify-button').click()
        expect(consumer.page.locator('#result')).to_contain_text('verified in test mode')
        consumer.page.locator('#offers button').first.click()
        expect(consumer.page.locator('#coupon-result')).to_contain_text('Present this coupon token')
        coupon_token=consumer.page.locator('#coupon-result').inner_text().split(': ',1)[1]
        record('consumer verifies and claims a real isolated test coupon',len(coupon_token)>=32)
        consumer.page.locator('#revoke-marketing').click()
        expect(consumer.page.locator('#result')).to_contain_text('consent revoked')
        record('consumer can withdraw channel consents')
        consumer.page.locator('#lang-bn').click()
        record('consumer switches to Bengali',consumer.page.locator('html').get_attribute('lang')=='bn')
        consumer.page.locator('#lang-en').click()
        consumer.page.set_viewport_size({'width':1100,'height':1000});consumer.fits('consumer/1100');consumer.screenshot('consumer-desktop')
        if not args.dom_harness:
            consumer.page.reload();expect(consumer.page.locator('#offers-step')).to_be_visible()
            record('native sessionStorage restores member pass after reload')

        staff=Surface(browser,'/staff');staff.login('cashier')
        expect(staff.page.locator('#page-cashier')).to_be_visible()
        record('cashier only sees the operational module',
               staff.page.locator('.nav button[data-page]:visible').count()==1)
        staff.page.locator('#cashier-reserve-form [name=coupon_token]').fill(coupon_token)
        staff.page.locator('#cashier-reserve-form [name=pos_order_ref]').fill('QA-POS-BROWSER-001')
        staff.page.locator('#cashier-reserve-form button').click()
        expect(staff.page.locator('#cashier-reserve-result')).to_contain_text('已保留')
        staff.page.locator('#cashier-match-form [name=order_source]').fill('browser_pos')
        staff.page.locator('#cashier-match-form button').click()
        expect(staff.page.locator('#notice')).to_contain_text('pos_order_not_found')
        record('cashier reservation cannot be converted into payment without POS import')
        # Real authorized POS staging + commit via the actual operator UI.
        paid=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(seconds=2)).isoformat(timespec='seconds')
        complete=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
        csv='tenant_id,store_id,source,external_order_id,member_id,paid_at,currency,amount_paid_minor,status\n'
        csv+=f'ten_demo_01,sto_demo_01,browser_pos,QA-POS-BROWSER-001,{member_id},{paid},BDT,15000,paid'
        admin.go('imports')
        admin.page.locator('#import-form [name=source]').fill('browser_pos')
        admin.page.locator('#import-form [name=content]').fill(csv)
        admin.page.locator('#import-form button[type=submit], #import-form button:not([type])').first.click()
        expect(admin.page.locator('#commit-import')).to_be_enabled()
        admin.page.locator('#commit-import').click()
        expect(admin.page.locator('#notice')).to_contain_text('CSV 已提交')
        staff.page.locator('#cashier-match-form button').click()
        expect(staff.page.locator('#cashier-match-result')).to_contain_text('redeemed')
        record('real source -> member -> coupon -> cashier -> POS CSV -> redeemed chain')
        staff.screenshot('staff-desktop')
        staff.page.set_viewport_size({'width':390,'height':950});staff.fits('staff/390');staff.screenshot('staff-mobile')
        admin.go('overview');admin.screenshot('home-with-pos-evidence')

        if args.dom_harness:
            admin.fail_reads.add('/api/content')
            admin.load('/admin')
            expect(admin.page.locator('#ab-home')).to_contain_text('读取失败')
            admin.go('content');expect(admin.page.locator('#page-content [data-load-error]')).to_be_visible()
            record('fault injection: failed read is not shown as an empty successful queue')
            admin.fail_reads.clear()
        for name,surface in [('admin',admin),('review',reviewer),('staff',staff),('consumer',consumer)]:
            record(name+' final JavaScript error check',not surface.errors,surface.errors)
        browser.close()
except Exception as exc:
    error=str(exc)
    checks.append({'name':'execution_stopped','passed':False,'detail':error})
finally:
    fixture.terminate()
    try:fixture.wait(timeout=8)
    except subprocess.TimeoutExpired:fixture.kill();fixture.wait()
    result={'mode':'in_memory_DOM_with_real_HTTP_bridge' if args.dom_harness else 'native_browser_e2e',
            'business_data':'isolated synthetic tenant; actual application HTTP routes and JSON repository',
            'native_navigation_verified':not args.dom_harness and error is None,
            'browser_cookie_security_verified':False,
            'native_storage_verified':not args.dom_harness and error is None,
            'limitations':['Chromium only', 'No live model/channel writes',
              *(['Browser navigation blocked by environment; DOM loads via set_content; fetch uses Python cookie jar; images embedded unchanged; no native cookies/storage/navigation acceptance'] if args.dom_harness else [])],
            'passed':sum(x['passed'] for x in checks),'failed':sum(not x['passed'] for x in checks),'checks':checks}
    OUTPUT.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'mode':result['mode'],'passed':result['passed'],'failed':result['failed'],'error':error},ensure_ascii=False))
    if error:sys.exit(1)
