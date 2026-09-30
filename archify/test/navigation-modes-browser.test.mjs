import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChrome } from '../bin/visual-check.mjs';
import { desktopBrowser } from './helpers/desktop-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.ARCHIFY_CHROME ? findChrome() : null;
const controls = { route: '#btn-route-probe', map: '#btn-overview-map', lens: '#btn-semantic-lens' };

test('Path, Map and Lens retain dev selection, panel and URL handoffs', {
  skip: chrome ? false : 'Set ARCHIFY_CHROME for navigation tool switching.',
}, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-navigation-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const file = path.join(scratch, 'architecture.html');
  execFileSync(process.execPath, [path.join(root, 'bin/archify.mjs'), 'render', 'architecture',
    path.join(root, 'examples/web-app.architecture.json'), file]);
  const browser = desktopBrowser(chrome); t.after(() => browser.close());
  const session = await browser.sessionPromise;
  const send = (method, params = {}) => browser.cdp.send(method, params, session);
  const run = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(r.exceptionDetails, undefined, r.exceptionDetails?.exception?.description);
    return r.result?.value;
  };
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.navigationErrors=[];addEventListener('error',e=>navigationErrors.push(e.message));addEventListener('unhandledrejection',e=>navigationErrors.push(String(e.reason)));` });
  async function settle() {
    await run(`Archify.viewerChromeLayout.whenStable().then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))`);
  }
  async function load() {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const ready = browser.cdp.waitFor('Page.loadEventFired', session);
    await send('Page.navigate', { url: pathToFileURL(file).href + '?theme=light' }); await ready;
    await run('document.fonts.ready.then(()=>Archify.readerLayout.whenStable())'); await settle();
    await run('Archify.view.zoomIn()'); await settle();
  }
  async function click(selector) {
    const p = await run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await settle();
  }
  async function state() {
    return run(`(()=>{const svg=document.querySelector('.diagram-container > svg');return {
      modes:{route:!!Archify.routeProbe.active(),map:Archify.radar.isOpen(),lens:Archify.semanticLens.isOpen()||!!Archify.semanticLens.active()},
      buttons:Object.fromEntries(Object.entries(${JSON.stringify(controls)}).map(([k,s])=>{const b=document.querySelector(s);return [k,b.getAttribute('aria-pressed')==='true'||b.getAttribute('aria-expanded')==='true'];})),
      panels:{route:!document.getElementById('route-probe').hidden,map:!document.getElementById('overview-map').hidden,lens:!document.getElementById('semantic-lens').hidden},
      lens:Archify.semanticLens.active(),route:Archify.routeProbe.active(),hash:location.hash,camera:Archify.view.state(),
      routePaint:svg.querySelectorAll('[data-route-match],[data-route-step]').length,
      lensPaint:svg.querySelectorAll('[data-lens-match]').length,playing:Archify.routeProbe.isJourneyPlaying(),errors:navigationErrors};})()`);
  }
  const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/dev-navigation-handoffs.json', import.meta.url), 'utf8'));
  async function check(label) {
    const current = await state();
    assert.deepEqual(current.errors, []);
    const actual = { modes: current.modes, buttons: current.buttons, panels: current.panels,
      lens: current.lens, route: current.route, hash: current.hash, playing: current.playing,
      routePaint: current.routePaint > 0, lensPaint: current.lensPaint > 0, cameraMode: current.camera.mode };
    assert.deepEqual(actual, expected[label], label);
  }
  for (const from of Object.keys(controls)) for (const to of Object.keys(controls)) {
    if (from === to) continue;
    await t.test(`${from} to ${to}: native controls follow dev handoff`, async () => {
      await load(); await click(controls[from]); await click(controls[to]);
      await check(from + '-to-' + to);
    });
  }
  for (const to of ['route', 'map']) await t.test(`active Lens to ${to}`, async () => {
    await load(); await run(`Archify.semanticLens.select('database')`); await settle();
    await click(controls[to]); await check('active-lens-to-' + to);
  });
  for (const to of ['map', 'lens']) await t.test(`completed Path to ${to}`, async () => {
    await load(); await run(`Archify.routeProbe.begin({source:'users'});Archify.routeProbe.choose('db');`);
    await run(`new Promise(r=>setTimeout(r,800))`);
    await run(to==='map'?'Archify.radar.open()':'Archify.semanticLens.open()');await settle();await check('path-to-' + to);
  });
  await t.test('route deep link takes ownership from Lens', async () => {
    await load(); await run(`Archify.semanticLens.select('database');location.hash='route=users~db'`);
    await settle(); await check('route-deep-link');
  });
  await t.test('direct Lens selection while Map is open follows dev ownership', async () => {
    await load(); await click(controls.map);
    await run(`Archify.semanticLens.select('database')`); await settle(); await check('direct-lens-from-map');
  });
});
