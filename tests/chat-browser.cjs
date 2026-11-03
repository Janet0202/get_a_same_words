// Start server.py first, then run: node tests/chat-browser.cjs
// Requires Playwright and Chromium in the development environment.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8003';
const gate = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const errors = [];
  async function setup() {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.locator('#create').click();
    await page.locator('#start').waitFor();
    const host = await page.evaluate(() => ({ ...session }));
    async function call(action, identity = host, data = {}) {
      const response = await page.request.post(`${base}/api/${action}`, { data: { ...identity, ...data } });
      assert.equal(response.ok(), true, await response.text());
      return response.json();
    }
    const joined = await call('join', {}, { code: host.code });
    const guest = { code: joined.code, token: joined.token };
    await page.waitForFunction(() => state.players.length === 2);
    return { page, host, guest, call };
  }
  try {
    // Hold an acknowledged send while the game rerenders and the player types again.
    {
      const { page, call, guest } = await setup();
      const oldSnapshot = await call('state');
      const received = gate(), release = gate();
      await page.route('**/api/chat', async route => {
        const response = await route.fetch();
        received.resolve();
        await release.promise;
        await route.fulfill({ response });
      });
      await page.locator('#chat-text').fill('已经发出的消息');
      await page.locator('#chat-send').click();
      await received.promise;
      assert.equal(await page.locator('#chat-text').inputValue(), '');
      assert.equal(await page.locator('#chat-send').textContent(), '发送中…');
      await page.evaluate(() => { window.originalChatInput = document.querySelector('#chat-text'); render(); });
      assert.equal(await page.evaluate(() => originalChatInput === document.querySelector('#chat-text')), true);
      await page.locator('#chat-text').fill('下一条草稿');
      release.resolve();
      await page.waitForFunction(() => !chatSending);
      assert.equal(await page.locator('#chat-text').inputValue(), '下一条草稿');
      assert.equal(await page.locator('.chat-bubble').count(), 1);
      await page.evaluate(old => applyState(old), oldSnapshot);
      assert.equal(await page.locator('.chat-bubble').count(), 1, 'stale poll must not remove sent message');
      await page.evaluate(() => window.firstBubble = document.querySelector('.chat-bubble'));
      await call('chat', guest, { text: '朋友的新消息' });
      await page.waitForFunction(() => state.messages.length === 2);
      assert.equal(await page.evaluate(() => firstBubble === document.querySelector('.chat-bubble')), true);
      await page.screenshot({ path: '/workspace/previews/chat-fixed-mobile.png', fullPage: true });
      await page.close();
      console.log('PASS delayed send, rerender, new draft, stale snapshot, incremental chat DOM');
    }
    // Server receives the message, but the response is lost; retry must not duplicate.
    {
      const { page, call } = await setup();
      let first = true;
      await page.route('**/api/chat', async route => {
        if (first) { first = false; await route.fetch(); await route.abort('failed'); }
        else await route.continue();
      });
      await page.locator('#chat-text').fill('丢失回执的消息');
      await page.locator('#chat-send').click();
      await page.waitForFunction(() => !chatSending && chatDraft === '丢失回执的消息');
      assert.equal(await page.locator('#chat-text').inputValue(), '丢失回执的消息');
      await page.locator('#chat-send').click();
      await page.waitForFunction(() => !chatSending && chatDraft === '');
      assert.equal(await page.locator('#chat-text').inputValue(), '');
      assert.equal((await call('state')).messages.length, 1);
      await page.close();
      console.log('PASS lost acknowledgement, text recovery, retry deduplication, successful clear');
    }
    // A failed request must not overwrite a newer draft typed while waiting.
    {
      const { page } = await setup();
      const received = gate(), release = gate();
      await page.route('**/api/chat', async route => { received.resolve(); await release.promise; await route.abort('failed'); });
      await page.locator('#chat-text').fill('失败的旧消息');
      await page.locator('#chat-send').click();
      await received.promise;
      await page.locator('#chat-text').fill('正在写的新消息');
      release.resolve();
      await page.waitForFunction(() => !chatSending);
      assert.equal(await page.locator('#chat-text').inputValue(), '正在写的新消息');
      await page.close();
      console.log('PASS send failure preserves newer draft');
    }
    // IME Enter confirms composition without submitting; regular Enter sends once.
    {
      const { page, call } = await setup();
      await page.locator('#chat-text').fill('中文输入');
      await page.locator('#chat-text').dispatchEvent('compositionstart');
      await page.locator('#chat-text').press('Enter');
      assert.equal((await call('state')).messages.length, 0);
      await page.locator('#chat-text').dispatchEvent('compositionend');
      await page.locator('#chat-text').press('Enter');
      await page.waitForFunction(() => !chatSending && state.messages.length === 1);
      assert.equal(await page.locator('#chat-text').inputValue(), '');
      await page.close();
      console.log('PASS Chinese composition and Enter send');
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
