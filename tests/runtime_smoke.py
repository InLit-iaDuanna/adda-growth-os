"""Verify the delivered precompiled app without node_modules or npm install.
Copy only dist, public assets and the demo launcher into a fresh directory;
start actual Web+worker, check authorization and persistent run recovery.
"""
from pathlib import Path
import json, os, shutil, signal, socket, subprocess, tempfile, time
from urllib.error import HTTPError, URLError
from urllib.request import build_opener, HTTPCookieProcessor, Request
from http.cookiejar import CookieJar

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts/unified-2026-09-25/runtime-smoke.json'
checks=[]

def check(name,condition):
    checks.append({'name':name,'passed':bool(condition)})
    if not condition:raise AssertionError(name)

with tempfile.TemporaryDirectory(prefix='adda-runtime-') as temp:
    root=Path(temp)
    shutil.copytree(ROOT/'dist',root/'dist')
    shutil.copytree(ROOT/'apps/web/public',root/'apps/web/public')
    (root/'scripts').mkdir();shutil.copy2(ROOT/'scripts/demo.mjs',root/'scripts/demo.mjs')
    check('runtime copy contains no node_modules',not (root/'node_modules').exists())
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    base=f'http://127.0.0.1:{port}';client=build_opener(HTTPCookieProcessor(CookieJar()))
    csrf=''
    def api(path,data=None):
        headers={'content-type':'application/json'}
        if csrf:headers['x-csrf-token']=csrf
        req=Request(base+path,headers=headers,data=json.dumps(data).encode() if data is not None else None)
        with client.open(req,timeout=3) as r:return r.status,json.loads(r.read())
    logs=open(root/'runtime.log','w');process=None
    def start():
        global process
        process=subprocess.Popen(['node','scripts/demo.mjs'],cwd=root,env={**os.environ,'PORT':str(port)},stdout=logs,stderr=logs)
        for _ in range(70):
            try:
                code,data=api('/api/healthz')
                if code==200:return data
            except (URLError,OSError):pass
            if process.poll() is not None:raise RuntimeError('launcher failed: '+(root/'runtime.log').read_text())
            time.sleep(.1)
        raise TimeoutError('server startup')
    def stop():
        if process and process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:process.wait(timeout=8)
            except subprocess.TimeoutExpired:process.kill();process.wait();raise RuntimeError('launcher did not stop')
    failure=None
    try:
        health=start();check('launcher starts only demo; real test outbox is disabled',health['mode']=='demo' and not health['connectors']['testOutbox']['enabled'])
        _,login=api('/api/auth/login',{'email':'owner@demo.adda.local','password':'demo-only-password'});csrf=login['csrf_token'];check('real login works without runtime dependencies',bool(csrf))
        _,created=api('/api/control/runs',{'plan':'content','prompt':'runtime smoke synthetic check','execution':'background','store_id':'sto_demo_01','request_key':'runtime_smoke_check_20260925'})
        run=created['item'];run_id=run['id']
        for _ in range(80):
            _,response=api('/api/control/runs/'+run_id);run=response['item']
            if run['status']=='completed':break
            time.sleep(.1)
        check('actual launcher worker completes a persisted background run',run['status']=='completed' and [n['attempts'] for n in run['nodes']]==[1,1])
        stop();check('graceful stop closes both web and worker',process.returncode==0)
        start();_,login=api('/api/auth/login',{'email':'owner@demo.adda.local','password':'demo-only-password'});csrf=login['csrf_token']
        _,saved=api('/api/control/runs/'+run_id);check('fresh launcher restart retains completed run, no duplicate attempt',saved['item']['status']=='completed' and [n['attempts'] for n in saved['item']['nodes']]==[1,1])
        for path in ['/admin','/review','/staff','/assets/brand/99b0b4ec1602cc2760ffed5944b53444.jpg']:
            with client.open(base+path) as response:check('runtime route '+path,response.status==200 and len(response.read())>100)
    except Exception as exc:failure=str(exc);checks.append({'name':'runtime_failure','passed':False,'detail':failure})
    finally:
        stop();logs.close()
        OUT.write_text(json.dumps({'mode':'fresh precompiled copy, actual localhost HTTP and real web+worker processes','no_dependency_install':True,'passed':sum(c['passed']for c in checks),'failed':sum(not c['passed']for c in checks),'checks':checks},ensure_ascii=False,indent=2)+'\n')
        print(OUT.read_text())
        if failure:raise RuntimeError(failure)
