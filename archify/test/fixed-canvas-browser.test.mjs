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

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configured = Object.hasOwn(process.env, 'ARCHIFY_CHROME');
const chrome = configured ? findChrome() : null;
if (configured && !chrome) throw new Error('ARCHIFY_CHROME must identify an executable browser.');

test('Infinite canvas retains original reader content, input ownership and specialized modes', {
  skip: chrome ? false : 'Set ARCHIFY_CHROME to run fixed-canvas browser checks.',
}, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-fixed-canvas-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const evidence = process.env.ARCHIFY_FIXED_CANVAS_EVIDENCE;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const records = [];
  t.after(() => {
    if (evidence) fs.writeFileSync(path.join(evidence, 'observations.json'), JSON.stringify(records, null, 2) + '\n');
  });

  // A small, redistributable portrait reproducer: no private repository data.
  const source = {
    schema_version: 1, diagram_type: 'architecture',
    meta: { title: 'Canvas containment', output: 'portrait.html', viewBox: [1000, 1300] },
    components: [
      { id: 'entry', type: 'frontend', label: 'Entry', sublabel: 'Input context', tag: 'ENTRY TAG', pos: [380, 90], size: [240, 80] },
      { id: 'result', type: 'backend', label: 'Result', sublabel: 'Output context', tag: 'RESULT TAG', pos: [380, 1120], size: [240, 80] },
    ],
    connections: [{ id: 'entry-result', from: 'entry', to: 'result', label: 'Execute request', labelDy: 24 }],
  };
  const fixtures = [];
  for (const [name, cards] of [
    ['portrait', []],
    ['long-notes', [{ dot: 'cyan', title: 'Complete explanation',
      items: Array.from({ length: 80 }, (_, i) => `Explanation item ${i + 1}`) }]],
  ]) {
    const spec = path.join(scratch, name + '.json');
    const file = path.join(scratch, name + '.html');
    fs.writeFileSync(spec, JSON.stringify({ ...source, cards }));
    execFileSync(process.execPath, [path.join(skillRoot, 'renderers/architecture/render-architecture.mjs'), spec, file]);
    fixtures.push({ name, file });
  }
  // The optional local artifact is inspected byte-for-byte; it is never checked in.
  if (process.env.ARCHIFY_FIXED_CANVAS_ARTIFACT) {
    const file = path.join(scratch, 'local-artifact.html');
    fs.copyFileSync(process.env.ARCHIFY_FIXED_CANVAS_ARTIFACT, file);
    fixtures.push({ name: 'local-artifact', file });
  }

  for (const [name, example] of Object.entries({
    architecture:'web-app.architecture.json', workflow:'agent-tool-call.workflow.json',
    sequence:'cache-miss-request.sequence.json', dataflow:'product-analytics.dataflow.json', lifecycle:'agent-run.lifecycle.json',
  })) {
    const file=path.join(scratch,name+'.html');
    execFileSync(process.execPath,[path.join(skillRoot,`renderers/${name}/render-${name}.mjs`),path.join(skillRoot,'examples',example),file]);
    fixtures.push({name,file});
  }

  const browser = desktopBrowser(chrome);
  t.after(() => browser.close());
  const session = await browser.sessionPromise;
  const send = (method, params = {}) => browser.cdp.send(method, params, session);
  await browser.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
  async function run(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  }
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.fixedCanvasErrors = [];
    addEventListener('error', e => fixedCanvasErrors.push(e.message));
    addEventListener('unhandledrejection', e => fixedCanvasErrors.push(String(e.reason)));
  ` });
  async function stable() {
    await run(`(async()=>{ await document.fonts.ready;
      await Archify.readerLayout.whenStable(); await Archify.viewerChromeLayout.whenStable();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); })()`);
  }
  async function load(fixture, width=1440, height=900, theme='light', query='') {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    const loaded=browser.cdp.waitFor('Page.loadEventFired',session);
    await send('Page.navigate',{url:pathToFileURL(fixture.file).href+'?theme='+theme+query});
    await loaded; await stable();
  }
  async function shot(name) {
    if (!evidence) return;
    const image=await send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(image.data,'base64'));
  }
  for (const fixture of fixtures) for (const [width,height] of [[1024,600],[1440,900],[2048,1320],[390,844]]) for (const theme of ['light','dark']) {
    await t.test(`${fixture.name}-${width}-${theme} retains complete content and default reading`, async () => {
      await load(fixture,width,height,theme);
      const o=await run(`(()=>{const s=document.querySelector('.diagram-container > svg');return {
        state:Archify.view.state(),detail:document.querySelector('.diagram-container').dataset.detailLevel,
        cards:document.querySelectorAll('.cards').length,rail:!!document.getElementById('reader-rail'),
        replacement:!!document.getElementById('btn-diagram-notes'),text:document.querySelector('.reader-rail').textContent,
        nodes:s.querySelectorAll('[data-node-id]').length,index:document.querySelectorAll('.node-outline-list [data-node-id]').length,
        horizontal:document.scrollingElement.scrollWidth-innerWidth,errors:fixedCanvasErrors};})()`);
      assert.deepEqual(o.state,{scale:1,x:0,y:0,mode:'overview'});
      assert.equal(o.detail,'read');assert.equal(o.rail,true);assert.equal(o.replacement,false);
      assert.equal(o.cards,1);assert.ok(o.nodes>0);assert.ok(o.horizontal<=1);assert.deepEqual(o.errors,[]);
      if(fixture.name==='long-notes')assert.match(o.text,/Explanation item 80/);
      records.push({fixture:fixture.name,width,height,theme,...o});await shot(fixture.name+'-'+width+'-'+theme);
    });
  }
  await t.test('sidebar native scroll, text editing, links and keyboard do not move the canvas',async()=>{
    await load(fixtures.find(f=>f.name==='long-notes'),1920,1080);
    await run(`localStorage.setItem('archify-rail-placement','right');localStorage.setItem('archify-rail-collapsed','0')`);
    await load(fixtures.find(f=>f.name==='long-notes'),1920,1080);
    if(await run(`!document.getElementById('rail-reveal').hidden`))await run(`document.getElementById('rail-reveal').click()`);
    await stable();
    const before=await run('Archify.view.state()');
    const point=await run(`(()=>{const p=document.getElementById('reader-rail'),r=p.getBoundingClientRect();return {x:r.left+r.width/2,y:Math.min(innerHeight-40,r.top+100)};})()`);
    await send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaY:600,deltaX:0});await stable();
    assert.deepEqual(await run('Archify.view.state()'),before);
    await run(`(()=>{const p=document.getElementById('reader-rail');p.scrollTop=0;const input=document.createElement('input');input.id='note-input';input.value='Original';p.prepend(input);const link=document.createElement('a');link.id='note-link';link.href='#note-input';link.textContent='Return to note';input.after(link);input.focus();input.select();})()`);
    await send('Input.insertText',{text:'Updated note'});
    for(const [key,code,vk] of [['ArrowLeft','ArrowLeft',37],['ArrowRight','ArrowRight',39]])for(const type of ['keyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:vk});
    assert.equal(await run(`document.getElementById('note-input').value`),'Updated note');
    assert.deepEqual(await run('Archify.view.state()'),before);
    for(const type of ['keyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    assert.equal(await run('document.activeElement.id'),'note-link');
    assert.deepEqual(await run('Archify.view.state()'),before);
  });
  await t.test('twenty placement and collapse cycles preserve one complete notes and index tree',async()=>{
    await load(fixtures.find(f=>f.name==='architecture'),1920,1080);
    const original=await run(`document.getElementById('reader-rail').textContent`);
    for(let i=0;i<20;i++){
      await run(`document.getElementById('rail-placement').click()`);await stable();
      if(await run(`document.documentElement.getAttribute('data-reader-rail')==='bottom'`)){await run(`document.getElementById('rail-placement').click()`);await stable();}
      await run(`document.getElementById('rail-collapse').click()`);await stable();
      assert.equal(await run(`document.getElementById('rail-reveal').hidden`),false);
      await run(`document.getElementById('rail-reveal').click()`);await stable();
      assert.equal(await run(`document.getElementById('reader-rail').textContent`),original);
      assert.equal(await run(`document.querySelectorAll('.node-outline').length`),1);
    }
  });
  await t.test('all presets retain dev progressive detail and semantic hover reveal',async()=>{
    for(const preset of ['classic','signal-flow','blueprint','editorial'])for(const theme of ['light','dark']){
      await load(fixtures.find(f=>f.name==='portrait'),1440,900,theme);
      await run(`Archify.preset.apply(${JSON.stringify(preset)});Archify.view.zoomAt(.75,400,300)`);await stable();
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
      const opacity=()=>run(`Number(getComputedStyle(document.querySelector('[data-node-id="entry"] [data-detail="context"]')).opacity)`);
      await run('new Promise(r=>setTimeout(r,200))');assert.equal(await opacity(),0);
      await run(`Archify.focus.set('entry',{toggle:false})`);await run('new Promise(r=>setTimeout(r,220))');assert.equal(await opacity(),1);
      await run(`Archify.focus.clear();Archify.view.zoomAt(2,400,300)`);await stable();
      assert.equal(await run(`document.querySelector('.diagram-container').dataset.detailLevel`),'full');
    }
  });
  await t.test('print and specialized modes retain all original explanations and export content',async()=>{
    await load(fixtures.find(f=>f.name==='long-notes'));
    await run(`Archify.view.zoomAt(2,400,300);Archify.view.panBy(80,-150)`);await stable();
    await send('Emulation.setEmulatedMedia',{media:'print'});await stable();
    const o=await run(`(()=>{const s=document.querySelector('.diagram-container > svg');return {cards:document.querySelector('.cards').getBoundingClientRect().height,text:document.querySelector('.cards').textContent,transform:getComputedStyle(s).transform,clip:getComputedStyle(s).clipPath,grid:getComputedStyle(document.querySelector('.infinite-canvas-grid')).display,hidden:[...s.querySelectorAll('[data-detail]')].some(e=>Number(getComputedStyle(e).opacity)!==1)};})()`);
    assert.ok(o.cards>0);assert.match(o.text,/Explanation item 80/);assert.equal(o.transform,'none');assert.equal(o.clip,'none');assert.equal(o.grid,'none');assert.equal(o.hidden,false);
    if(evidence){const pdf=await send('Page.printToPDF',{printBackground:true});fs.writeFileSync(path.join(evidence,'reader-print.pdf'),Buffer.from(pdf.data,'base64'));}
    await send('Emulation.setEmulatedMedia',{media:''});
    for(const query of ['&embed=1','&present=1','&embed=1&present=1']){
      await load(fixtures[0],1440,900,'light',query);
      assert.equal(await run(`document.documentElement.hasAttribute('data-fixed-canvas')`),false);
      assert.deepEqual(await run('fixedCanvasErrors'),[]);
    }
  });
});
