// Run against a dedicated local server, never a live game room.
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:8004';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 try{
  const page=await browser.newPage();
  const response=await page.goto(base);
  assert.equal(response.headers()['cache-control'],'no-store');
  const html=await response.text();
  assert.match(html,/app\.js\?v=[a-f0-9]{12}/);
  assert.match(html,/style\.css\?v=[a-f0-9]{12}/);
  assert.ok(!html.includes('__ASSET_VERSION__'));
  const conditional=await page.request.get(base,{headers:{'If-Modified-Since':'Wed, 01 Jan 2031 00:00:00 GMT'}});
  assert.equal(conditional.status(),200);
  const js=await page.request.get(base+'/'+html.match(/src="(app.js[^\"]*)"/)[1]);
  assert.equal(js.headers()['cache-control'],'no-store');
  await page.locator('#create').click();await page.locator('#start').waitFor();
  await page.evaluate(async()=>{await poll();await poll()});
  assert.equal(await page.locator('#toast').isVisible(),false);
  // Make a rendering error explicit rather than calling it a connection failure.
  await page.evaluate(async()=>{const original=applyState;applyState=()=>{throw Error('test render failure')};await poll();applyState=original});
  assert.equal(await page.locator('#toast').textContent(),'页面更新失败，请刷新页面');
  await page.close();
  const legacy=await browser.newPage();
  const oldScript=execFileSync('git',['show','f54a54c:web/app.js'],{encoding:'utf8'});
  await legacy.route('**/app.js*',route=>route.fulfill({contentType:'application/javascript',body:oldScript}));
  await legacy.goto(base);await legacy.locator('#create').click();await legacy.locator('#start').waitFor();
  const result=await legacy.evaluate(async()=>{const s=await api('state');updateLive();await poll();return {events:s.events,steps:s.players[0].steps,toast:document.querySelector('#toast').textContent}});
  assert.deepEqual(result.events,[]);assert.equal(result.steps,0);assert.equal(result.toast,'');
  await legacy.close();
  console.log('PASS: versioned assets, no-store, conditional HTML returns fresh 200, current polling, legacy client compatibility, distinct render error');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
