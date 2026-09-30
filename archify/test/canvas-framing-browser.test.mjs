import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChrome } from '../bin/visual-check.mjs';
import { desktopBrowser } from './helpers/desktop-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configured = Object.hasOwn(process.env, 'ARCHIFY_CHROME');
const chrome = configured ? findChrome() : null;
if (configured && !chrome) throw new Error('ARCHIFY_CHROME must identify an executable browser.');
const examples = {architecture:'web-app.architecture.json',workflow:'agent-tool-call.workflow.json',
  sequence:'cache-miss-request.sequence.json',dataflow:'product-analytics.dataflow.json',lifecycle:'agent-run.lifecycle.json'};
const observation = `(() => {
  const c=document.querySelector('.diagram-container'),s=c.querySelector(':scope > svg'),v=s.viewBox.baseVal;
  const r=e=>{const a=e.getBoundingClientRect();return {left:a.left,top:a.top,right:a.right,bottom:a.bottom,width:a.width,height:a.height};};
  const style=getComputedStyle(c),b=c.getBoundingClientRect();
  const stage={left:Math.max(b.left+c.clientLeft,0)+parseFloat(style.paddingLeft),top:Math.max(b.top+c.clientTop,0)+parseFloat(style.paddingTop),
    right:Math.min(b.left+c.clientLeft+c.clientWidth,innerWidth)-parseFloat(style.paddingRight),bottom:Math.min(b.top+c.clientTop+c.clientHeight,innerHeight)-parseFloat(style.paddingBottom)};
  const matrix=s.getScreenCTM(),p=new DOMPoint((stage.left+stage.right)/2,(stage.top+stage.bottom)/2).matrixTransform(matrix.inverse());
  return {state:Archify.view.state(),fixed:document.documentElement.hasAttribute('data-fixed-canvas'),
    stage,svg:r(s),effective:matrix.a,center:{x:p.x,y:p.y},node:r(s.querySelector('[data-node-id]')),
    viewBox:s.getAttribute('viewBox'),range:[document.scrollingElement.scrollWidth-innerWidth,document.scrollingElement.scrollHeight-innerHeight],
    page:[scrollX,scrollY],notes:document.documentElement.hasAttribute('data-notes-open'),
    nodes:[...s.querySelectorAll('[data-node-id]')].map(n=>n.dataset.nodeId),
    texts:[...s.querySelectorAll('text')].map(n=>n.textContent),errors:framingErrors};
})()`;
function contained(o,label) {
  assert.equal(o.fixed,true,label);
  for(const [a,b,sign] of [['left','left',1],['top','top',1],['right','right',-1],['bottom','bottom',-1]])
    assert.ok(sign*(o.svg[a]-o.stage[b])>=14,`${label} ${a}: ${JSON.stringify(o)}`);
  assert.ok(Math.abs((o.svg.left+o.svg.right-o.stage.left-o.stage.right)/2)<=2,label+' horizontal center');
  assert.ok(Math.abs((o.svg.top+o.svg.bottom-o.stage.top-o.stage.bottom)/2)<=2,label+' vertical center');
  assert.ok(o.effective>0,label+' valid scale');
  assert.ok(o.range.every(v=>v<=1),label+' no page overflow');
  assert.deepEqual(o.page,[0,0],label+' stationary page');assert.deepEqual(o.errors,[]);
}
function sameReading(before,after,label) {
  assert.ok(Math.abs(after.effective/before.effective-1)<=.005,label+' actual scale');
  for(const k of ['width','height'])assert.ok(Math.abs(after.node[k]-before.node[k])<=1,label+' actual node '+k);
  assert.ok(Math.abs(after.center.x-before.center.x)*after.effective<=2,label+' horizontal reading point');
  assert.ok(Math.abs(after.center.y-before.center.y)*after.effective<=2,label+' vertical reading point');
  assert.deepEqual(after.errors,[]);
}

function framingFixtures(scratch) {
  const fixtures=[];
  function render(name,mode,source,repo) {
    const file=path.join(scratch,name+'.html');
    execFileSync(process.execPath,[path.join(root,'bin/archify.mjs'),'render',mode,source,file,...(repo?['--repo-root',repo]:[])]);
    fixtures.push({name,file,source,sha256:createHash('sha256').update(fs.readFileSync(source)).digest('hex')});
  }
  for(const [mode,name] of Object.entries(examples))render(mode,mode,path.join(root,'examples',name));
  if(process.env.ARCHIFY_FRAMING_MAKA_SOURCE)render('maka','architecture',process.env.ARCHIFY_FRAMING_MAKA_SOURCE,process.env.ARCHIFY_FRAMING_MAKA_ROOT);
  const small={schema_version:1,diagram_type:'architecture',meta:{title:'Small diagram',output:'small.html',viewBox:[600,260]},
    components:[{id:'entry',type:'frontend',label:'Entry',sublabel:'Input context',pos:[40,70],size:[180,70]},
      {id:'result',type:'backend',label:'Result',sublabel:'Output context',pos:[380,70],size:[180,70]}],
    connections:[{from:'entry',to:'result',label:'Execute'}],
    cards:[{dot:'cyan',title:'Complete explanation',items:Array.from({length:80},(_,i)=>'Explanation item '+(i+1))}]};
  const smallSource=path.join(scratch,'small.json');fs.writeFileSync(smallSource,JSON.stringify(small));render('small','architecture',smallSource);
  render('long-300','workflow',path.resolve(root,'../benchmarks/hybrid-large-world-viewer-pilot/corpus/workflow-300.workflow.json'));
  const wide=JSON.parse(fs.readFileSync(path.join(root,'examples',examples.sequence)));wide.meta.viewBox[0]=24000;
  const wideSource=path.join(scratch,'wide.json');fs.writeFileSync(wideSource,JSON.stringify(wide));render('wide','sequence',wideSource);
  return fixtures;
}

test('Canvas framing fixtures render successfully before browser verification',t=>{
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'archify-framing-preflight-'));
  t.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
  const fixtures=framingFixtures(scratch);
  for(const fixture of fixtures)assert.ok(fs.statSync(fixture.file).size>0,fixture.name);
});

test('Canvas preserves dev initial reading and explicit Fit all navigation',{
  skip:chrome?false:'Set ARCHIFY_CHROME to run stable framing browser acceptance.',
},async t=>{
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'archify-framing-'));
  t.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
  const evidence=process.env.ARCHIFY_FRAMING_EVIDENCE;
  if(evidence)fs.mkdirSync(evidence,{recursive:true});
  const records=[];t.after(()=>{if(evidence)fs.writeFileSync(path.join(evidence,'observations.json'),JSON.stringify(records,null,2)+'\n');});
  const fixtures=framingFixtures(scratch);
  const browser=desktopBrowser(chrome);t.after(()=>browser.close());const session=await browser.sessionPromise;
  const send=(method,params={})=>browser.cdp.send(method,params,session);
  async function run(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.equal(r.exceptionDetails,undefined,r.exceptionDetails?.exception?.description);return r.result?.value;}
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.framingErrors=[];window.framingFrames=[];
    if(new URLSearchParams(location.search).has('framingDelayFonts')){
      const originalFonts=document.fonts;
      Object.defineProperty(document,'fonts',{configurable:true,value:{ready:new Promise(resolve=>{
        window.releaseFramingFonts=()=>{Object.defineProperty(document,'fonts',{configurable:true,value:originalFonts});resolve();};
      })}});
    }
    addEventListener('error',e=>framingErrors.push(e.message));addEventListener('unhandledrejection',e=>framingErrors.push(String(e.reason)));
    function frame(){const c=document.querySelector('.diagram-container'),s=c&&c.querySelector(':scope > svg');
      if(s&&s.clientWidth&&window.Archify&&Archify.view){const r=s.getBoundingClientRect(),b=c.getBoundingClientRect();
        framingFrames.push({state:Archify.view.state(),fixed:document.documentElement.hasAttribute('data-fixed-canvas'),
          rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},stage:{left:b.left,right:b.right,top:b.top,bottom:b.bottom}});}
      if(framingFrames.length<24)requestAnimationFrame(frame);}
    requestAnimationFrame(frame);`});
  async function stable(){await run(`(async()=>{await document.fonts.ready;await Archify.readerLayout.whenStable();await Archify.viewerChromeLayout.whenStable();
    let previous='',equal=0;for(let n=0;n<150;n++){await new Promise(requestAnimationFrame);const s=document.querySelector('.diagram-container > svg');
      const value=JSON.stringify([Archify.view.state(),s.getBoundingClientRect().toJSON(),getComputedStyle(s).transform]);
      equal=value===previous?equal+1:0;previous=value;if(equal>=8&&!document.querySelector('[data-camera-transaction]'))return;}
    throw new Error('Framing did not settle');})()`);}
  let loadId=0;
  async function load(file,width=1440,height=900,theme='light',hash='',wait=true){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    // Each case tests initialization, including links that otherwise navigate only the hash.
    const ready=browser.cdp.waitFor('Page.loadEventFired',session);await send('Page.navigate',{url:pathToFileURL(file).href+'?theme='+theme+'&framingLoad='+(++loadId)+hash});await ready;if(wait)await stable();
  }
  async function shot(name){if(evidence){const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(r.data,'base64'));}}
  async function sample(label){const o=await run(observation);records.push({label,...o});return o;}
  for(const fixture of fixtures)for(const [width,height] of [[1440,900],[2048,1320]])for(const theme of ['light','dark']){
    await t.test(`${fixture.name}-${width}-${theme}: original reading and explicit Fit all`,async()=>{
      const base=process.env.ARCHIFY_FRAMING_BASELINE&&path.join(process.env.ARCHIFY_FRAMING_BASELINE,fixture.name+'.html');
      let before;
      if(base&&fs.existsSync(base)){
        const spec=path.join(process.env.ARCHIFY_FRAMING_BASELINE,fixture.name+'.json');
        assert.equal(createHash('sha256').update(fs.readFileSync(spec)).digest('hex'),fixture.sha256,'same frozen source');
        await load(base,width,height,theme);before=await sample('dev-'+fixture.name+'-'+width+'-'+theme);await shot('dev-'+fixture.name+'-'+width+'-'+theme);
      }
      await load(fixture.file,width,height,theme);
      const initial=await sample('candidate-'+fixture.name+'-'+width+'-'+theme);await shot('candidate-'+fixture.name+'-'+width+'-'+theme);
      assert.deepEqual(initial.state,{scale:1,x:0,y:0,mode:'overview'});assert.equal(initial.fixed,true);
      assert.ok(initial.range.every(v=>v<=1),'bounded page at original reading size');assert.deepEqual(initial.page,[0,0]);assert.deepEqual(initial.errors,[]);
      if(before){
        assert.equal(initial.viewBox,before.viewBox);assert.deepEqual(initial.nodes,before.nodes);assert.deepEqual(initial.texts,before.texts);
        assert.ok(Math.abs(initial.effective/before.effective-1)<.005,'preserve dev initial reading scale: '+JSON.stringify({before:before.effective,after:initial.effective}));
      }
      await run('Archify.view.fitAll()');await stable();const fit=await sample('explicit-fit-'+fixture.name+'-'+width+'-'+theme);
      assert.equal(fit.state.mode,'fit');contained(fit,'explicit Fit all');
      await run('Archify.view.zoomIn()');await stable();const zoomed=await sample('zoom-'+fixture.name);
      assert.ok(zoomed.effective>fit.effective);
      await run('Archify.view.reset()');await stable();
      assert.deepEqual((await sample('reset-'+fixture.name)).state,initial.state);
    });
  }
  await t.test('manual reading survives placement changes and desktop resizes',async()=>{
    await load(fixtures[0].file,1920,1080);
    await run(`localStorage.setItem('archify-rail-placement','right');localStorage.setItem('archify-rail-collapsed','0')`);
    await load(fixtures[0].file,1920,1080);
    await run('Archify.view.zoomAt(2,400,300);Archify.view.panBy(-80,50)');await stable();
    let previous=await sample('manual');
    for(let i=0;i<20;i++){
      await run(`document.getElementById('rail-placement').click()`);await stable();
      const next=await sample('placement-'+i);sameReading(previous,next,'placement');previous=next;
    }
    for(const [width,height] of [[1100,700],[2048,1320],[1440,900],[1023,599],[1440,900]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await stable();
      const next=await sample('resize-'+width);sameReading(previous,next,'resize');previous=next;
    }
  });
  await t.test('late layout and invalid links retain default or explicit user intent',async()=>{
    for(const hash of ['', '#focus=missing-framing-node', '#focus=api']){
      await load(fixtures[0].file,1440,900,'light',hash);
      const initial=await sample('link-'+hash);
      assert.equal(initial.state.mode,hash==='#focus=api'?'semantic':'overview');
      await run('Archify.view.panBy(80,-50)');await stable();const manual=await sample('manual-link-'+hash);
      await run(`dispatchEvent(new Event('load'));Archify.readerLayout.schedule();Archify.viewerChromeLayout.schedule()`);await stable();
      sameReading(manual,await sample('late-link-'+hash),'late layout');
    }
  });
});
