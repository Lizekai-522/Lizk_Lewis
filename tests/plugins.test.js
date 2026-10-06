const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { PluginRegistry } = require('../lib/plugin-registry');
test('本机插件默认不执行，启用后注册工具、校验参数、撤权即时拒绝，卸载移到归档', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lewis-plugins-')); let permitted = true;
  const registry = new PluginRegistry(directory, { capabilities: { require: () => { if (!permitted) throw Error('权限关闭'); } } });
  const folder = path.join(registry.root, 'echo'); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'lewis.plugin.json'), JSON.stringify({ id: 'echo', name: '测试', permissions: ['web'], voiceCommands: [{ phrase: '测试插件', tool: 'echo' }] }));
  fs.writeFileSync(path.join(folder, 'index.js'), 'module.exports={tools:[{name:"echo",description:"echo",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false},execute:async args=>({text:args.text})}]}');
  try {
    await registry.reload(); assert.equal(registry.tools().length, 0);
    await registry.configure({ kind: 'plugin', id: 'echo', enabled: true }); assert.equal(registry.tools()[0].function.name, 'plugin_echo_echo');
    const call = { function: { name: 'plugin_echo_echo', arguments: '{"text":"你好"}' } }; assert.equal((await registry.execute(registry.parse(call))).text, '你好');
    assert.throws(() => registry.parse({ function: { ...call.function, arguments: '{"text":23}' } }), /Schema/);
    permitted = false; await assert.rejects(registry.execute(registry.parse(call)), /权限/); assert.equal(registry.tools().length, 0); permitted = true;
    await registry.uninstall('plugin','echo'); assert.equal(fs.existsSync(folder), false); assert.equal(fs.readdirSync(path.join(directory, 'plugin-archives')).length, 1);
  } finally { await registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
test('真实 MCP stdio 初始化、列工具、调用工具和断开，不继承云端 Key', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lewis-mcp-')); const file = path.join(directory,'fixture.cjs');
  fs.writeFileSync(file, `let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{text+=chunk;let i;while((i=text.indexOf('\\n'))>=0){let request=JSON.parse(text.slice(0,i));text=text.slice(i+1);if(request.id===undefined)continue;let result=request.method==='initialize'?{protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:request.method==='tools/list'?{tools:[{name:'echo',description:'测试',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}:{content:[{type:'text',text:request.params.arguments.text}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n')}});`);
  const registry = new PluginRegistry(directory, { capabilities: { require() {} } });
  try {
    await registry.configure({ kind: 'mcp', id: 'fixture', enabled: true, server: { command: process.execPath, args: [file], permissions: ['computer'] } });
    assert.equal(registry.list().mcp[0].error, ''); assert.equal(registry.tools().length, 1);
    assert.equal((await registry.execute({ name: 'mcp_fixture_echo', args: { text: '实际 stdio' } })).text, '实际 stdio');
    await registry.uninstall('mcp','fixture'); assert.equal(registry.tools().length, 0);
  } finally { await registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
