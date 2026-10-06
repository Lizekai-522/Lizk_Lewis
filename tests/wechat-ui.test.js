const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
test('微信按钮无需模型 Key 即可读写，提交用户全文与独立操作 ID，权限开关正确显示', async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), { url: 'http://localhost:3000', runScripts: 'outside-only' }); const window = dom.window;
  const posts = []; const id = '11111111-1111-4111-8111-111111111111';
  const result = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, options = {}) => {
    if (url === '/api/health') return result({ apiVersion: 2, version: '1.3.0' });
    if (url === '/api/session') return result({ sessionId: id });
    if (url === '/api/sessions') return result({ sessions: [] });
    if (url === '/api/history/' + id) return result({ messages: [] });
    if (url === '/api/history/' + id + '/skill') return result({ success: true });
    if (url === '/api/capabilities') return result({ web: true, computer: true, wechat: true });
    if (url === '/api/skills' && options.method === 'POST') { posts.push(JSON.parse(options.body)); return result({ text: '微信测试结果' }); }
    if (url === '/api/skills') return result({ skills: [] });
    throw new Error('不应请求 ' + url);
  };
  window.LewisVoice = class { setBusy() {} async destroy() {} };
  window.localStorage.setItem('lewis_settings', JSON.stringify({ autoMic: false, autoCamera: false, autoTts: false, apiKey: '' }));
  try {
    for (const name of ['appearance', 'speech', 'http', 'wechat-command', 'website-command', 'app']) window.eval(fs.readFileSync(path.join(__dirname, '../public/js', name + '.js'), 'utf8') + (name === 'app' ? '\nwindow.testApi = { ready: () => sessionReady, sending: () => isSending, parse: parseSkillCommand };' : ''));
    for (let i = 0; i < 30 && !window.testApi.ready(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    await window.testApi.ready(); assert.equal(window.document.getElementById('allowWechat').checked, true);
    const complete = async count => { for (let i = 0; i < 50 && (posts.length < count || window.testApi.sending()); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(posts.length, count); assert.equal(window.testApi.sending(), false); };
    window.document.getElementById('wechatReadBtn').click(); await complete(1);
    assert.equal(posts[0].skill, 'wechat-read'); assert.equal(posts[0].recipient, '文件传输助手');
    window.document.getElementById('wechatText').value = '你好，🙂\n第二行。';
    window.document.getElementById('wechatSendBtn').click(); await complete(2);
    assert.equal(posts[1].skill, 'wechat-send'); assert.equal(posts[1].text, '你好，🙂\n第二行。');
    assert.equal(posts[1].userMessage, '微信给文件传输助手发消息说你好，🙂\n第二行。');
    assert.match(posts[1].operationId, /^[a-f0-9-]{36}$/i); assert.notEqual(posts[0].operationId, posts[1].operationId);
    window.document.getElementById('messageInput').value = '李维斯帮我给文件传输助手发个微信我十分钟到';
    window.document.getElementById('sendBtn').click(); await complete(3);
    assert.equal(posts[2].skill, 'wechat-send'); assert.equal(posts[2].recipient, '文件传输助手');
    assert.equal(posts[2].text, '我十分钟到');
    assert.equal(posts[2].userMessage, '李维斯帮我给文件传输助手发个微信我十分钟到');
    assert.equal(window.testApi.parse('微信给张三发消息通知今晚聚餐取消，语气客气一点'), null);
    assert.equal(window.testApi.parse('打开Pornhub').url, 'https://www.pornhub.com/');
  } finally { window.close(); }
});
