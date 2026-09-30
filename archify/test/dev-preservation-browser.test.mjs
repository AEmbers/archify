import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChromeVisualBrowser, findChrome } from '../bin/visual-check.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.ARCHIFY_CHROME ? findChrome() : null;
const cases = {
  architecture: 'web-app.architecture.json', workflow: 'agent-tool-call.workflow.json',
  sequence: 'cache-miss-request.sequence.json', dataflow: 'product-analytics.dataflow.json',
  lifecycle: 'agent-run.lifecycle.json',
};

test('Infinite canvas preserves dev reading and progressive detail', {
  skip: chrome ? false : 'Set ARCHIFY_CHROME to run real-browser camera checks.',
}, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-camera-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const files = {};
  for (const [mode, example] of Object.entries(cases)) {
    files[mode] = path.join(scratch, `${mode}.html`);
    execFileSync(process.execPath, [path.join(skillRoot, `renderers/${mode}/render-${mode}.mjs`),
      path.join(skillRoot, 'examples', example), files[mode]]);
  }
  const browser = new ChromeVisualBrowser(chrome);
  t.after(() => browser.close());
  const session = await browser.sessionPromise;
  const send = (method, params = {}) => browser.cdp.send(method, params, session);
  await browser.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
  async function run(expression, awaitPromise = false) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  }
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.cameraErrors = [];
    addEventListener('error', e => cameraErrors.push(e.message));
    addEventListener('unhandledrejection', e => cameraErrors.push(String(e.reason)));
    window.cameraWait = predicate => new Promise((resolve, reject) => {
      let frames = 0;
      function sample() {
        if (predicate()) return resolve();
        if (++frames > 300) return reject(new Error('Camera observation did not settle'));
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
  ` });
  async function viewport(width = 1440, height = 900) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }
  async function stable() {
    // Observe automatic camera/layout work without forcing sync or measurement.
    await run(`(async () => {
      await document.fonts.ready;
      let previous = '', equal = 0;
      await cameraWait(() => {
        const container = document.querySelector('.diagram-container');
        const svg = container.querySelector(':scope > svg');
        const rect = svg.getBoundingClientRect();
        const current = JSON.stringify([Archify.view.state(), getComputedStyle(svg).transform,
          svg.style.clipPath, container.scrollLeft, container.getAttribute('data-camera-transaction'),
          container.style.getPropertyValue('--archify-nav-reserve'), rect.x, rect.y, rect.width, rect.height]);
        equal = current === previous ? equal + 1 : 0;
        previous = current;
        return equal >= 8 && !container.hasAttribute('data-camera-transaction');
      });
    })()`, true);
  }
  async function load(mode = 'architecture', { width = 1440, height = 900, theme = 'dark', reduced = false, embed = false } = {}) {
    await viewport(width, height);
    await send('Emulation.setEmulatedMedia', { media: '', features: [
      { name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' },
    ] });
    const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
    await send('Page.navigate', { url: pathToFileURL(files[mode]).href + `?theme=${theme}${embed ? "&embed=1" : ""}` });
    await loaded;
    await stable();
  }
  await t.test('MAP, READ and FULL follow zoom thresholds in every diagram family', async () => {
    for (const mode of Object.keys(cases)) {
      await load(mode, { reduced: true });
      for (const [scale, level] of [[1, 'read'], [0.99, 'map'], [1, 'read'], [1.749, 'read'], [1.75, 'full'], [2, 'full']]) {
        await run(`Archify.view.reset(); Archify.view.zoomAt(${scale}, 500, 300)`);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
        await stable();
        const actual = await run(`(() => {
          const container = document.querySelector('.diagram-container');
          const details = kind => [...container.querySelectorAll('svg [data-detail="' + kind + '"]')].map(e => Number(getComputedStyle(e).opacity));
          return { level: container.getAttribute('data-detail-level'), context: details('context'), fine: details('fine'), state: Archify.view.state() };
        })()`);
        assert.equal(actual.level, level, mode + ' at ' + scale);
        assert.ok(actual.context.length > 0, mode);
        assert.ok(actual.context.every(o => o === (level === 'map' ? 0 : 1)), JSON.stringify(actual));
        assert.ok(actual.fine.every(o => o === (level === 'full' ? 1 : 0)), JSON.stringify(actual));
        await run('Archify.view.panBy(20, 30)');
        await stable();
        assert.equal(await run(`document.querySelector('.diagram-container').getAttribute('data-detail-level')`), level);
      }
    }
  });
  await t.test('Map follows dev zoom visibility while infinite pan remains available at 100%', async () => {
    const visible = () => run(`getComputedStyle(document.getElementById('btn-overview-map')).display !== 'none'`);
    for (const mode of Object.keys(cases)) {
      await load(mode, { reduced: true });
      assert.equal(await visible(), false, mode + ': hidden at initial 100%');
      if (mode === 'architecture') {
        const point = await run(`(() => { const r = document.querySelector('.diagram-container').getBoundingClientRect(); return {x:r.left+12,y:r.top+12}; })()`);
        const before = await run('Archify.view.state()');
        await send('Input.dispatchMouseEvent', { type:'mouseMoved', ...point });
        await send('Input.dispatchMouseEvent', { type:'mousePressed', ...point, button:'middle', clickCount:1 });
        await send('Input.dispatchMouseEvent', { type:'mouseMoved', x:point.x+40,y:point.y+20,button:'middle',buttons:4 });
        await send('Input.dispatchMouseEvent', { type:'mouseReleased', x:point.x+40,y:point.y+20,button:'middle',clickCount:1 });
        await stable();
        const after = await run('Archify.view.state()');
        assert.ok(after.x > before.x + 10, 'native drag still pans at 100%');
        assert.equal(after.scale, 1);
        assert.equal(await visible(), false, 'pan does not reveal Map');
      }
      for (const [scale, expected] of [[.75,false],[.9999,false],[1,false],[1.0001,true],[1.25,true],[1,false]]) {
        await run(`Archify.view.zoomAt(${scale},500,300)`); await stable();
        assert.equal(await visible(), expected, mode + ': Map at ' + scale);
      }
      await run('Archify.view.zoomIn()'); await stable();
      assert.equal(await visible(), true);
      await run('Archify.view.reset()'); await stable();
      assert.equal(await visible(), false, mode + ': Reset hides Map');
      for (const [scale, expected] of [[1.01,true],[1,false]]) {
        await run(`Archify.view.zoomAt(${scale},500,300,{manual:false,defer:true})`); await stable();
        assert.equal(await visible(), expected, mode + ': continuous zoom at ' + scale);
      }
    }
    await load('architecture', { reduced: true });
    await run(`document.querySelector('.diagram-container').focus()`);
    for (const type of ['keyDown','keyUp']) await send('Input.dispatchKeyEvent',{type,key:'m',code:'KeyM',windowsVirtualKeyCode:77});
    await stable();
    assert.equal(await run('Archify.radar.isOpen()'), true, 'M still opens Map at 100%');
    assert.equal(await visible(), true, 'explicitly opened Map retains its control');
    await run('Archify.radar.close({restoreFocus:true})'); await stable();
    assert.equal(await visible(), true, 'closing retains the focused trigger');
    await run(`document.querySelector('.diagram-container').focus()`); await stable();
    assert.equal(await visible(), false, 'Map hides after focus leaves the closed trigger');
  });
  await t.test('original notes and index controls switch bottom, right and collapsed layouts', async () => {
    await load('architecture', { width: 1920, height: 1080, reduced: true });
    assert.equal(await run(`Boolean(document.getElementById('reader-rail'))`), true);
    assert.equal(await run(`Boolean(document.getElementById('btn-diagram-notes'))`), false);
    await run(`localStorage.setItem('archify-rail-placement', 'bottom');localStorage.setItem('archify-rail-collapsed', '0')`);
    await load('architecture', { width: 1920, height: 1080, reduced: true });
    const content = await run(`document.getElementById('reader-rail').textContent`);
    assert.equal(await run(`document.documentElement.getAttribute('data-reader-rail')`), 'bottom');
    await run(`document.getElementById('rail-placement').click()`); await stable();
    assert.equal(await run(`document.documentElement.getAttribute('data-reader-rail')`), 'true');
    assert.equal(await run(`document.getElementById('reader-rail').textContent`), content);
    await run(`document.getElementById('rail-collapse').click()`); await stable();
    assert.equal(await run(`document.documentElement.getAttribute('data-reader-rail')`), 'collapsed');
    assert.equal(await run(`document.getElementById('rail-reveal').hidden`), false);
    await run(`document.getElementById('rail-reveal').click()`); await stable();
    assert.equal(await run(`document.documentElement.getAttribute('data-reader-rail')`), 'true');
    assert.equal(await run(`document.getElementById('reader-rail').textContent`), content);
  });
  await t.test('switching the reader rail retains the manual reading point and text scale', async () => {
    await run(`localStorage.setItem('archify-rail-placement','bottom');localStorage.setItem('archify-rail-collapsed','0')`);
    await load('architecture', { width: 1920, height: 1080, reduced: true });
    await run(`Archify.view.zoomAt(2, 500, 300);Archify.view.panBy(50, -40)`); await stable();
    const reading = `(() => { const v = Archify.view.worldViewport(), svg = document.querySelector('.diagram-container > svg'); return { x:v.x+v.width/2, y:v.y+v.height/2, font:parseFloat(getComputedStyle(svg.querySelector('text[data-node-label]')).fontSize)*svg.getScreenCTM().a }; })()`;
    const before = await run(reading);
    await run(`document.getElementById('rail-placement').click()`); await stable();
    async function retained() {
      const after = await run(reading);
      for (const key of ['x','y','font']) assert.ok(Math.abs(after[key]-before[key]) < 1, JSON.stringify({before,after,key}));
      assert.ok(await run('document.scrollingElement.scrollHeight<=innerHeight+1'));
      assert.deepEqual(await run('({x:scrollX,y:scrollY})'),{x:0,y:0});
    }
    await retained();
    await run(`document.getElementById('rail-collapse').click()`);await stable();await retained();
    await run(`document.getElementById('rail-reveal').click()`);await stable();await retained();
    await run(`document.getElementById('rail-placement').click()`);await stable();await retained();
    for(const [width,height] of [[1440,900],[1024,600],[721,800],[1920,1080]]) {
      await viewport(width,height);await stable();await retained();
    }
  });
});
