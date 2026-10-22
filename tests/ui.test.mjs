import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs';
const base='/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/';
const j=createJiti(import.meta.url,{alias:{'@earendil-works/pi-ai':base+'pi-ai','@earendil-works/pi-tui':base+'pi-tui'}});
const {default:extension}=await j.import('../index.ts');
const {default:childUI}=await j.import('../child-ui.ts');
const {FleetView}=await j.import('../src/fleet-view.ts');
const {AgentPalette}=await j.import('../src/palette.ts');
const {createHerdr}=await j.import('../src/herdr.ts');
const {visibleWidth}=await j.import(base+'pi-tui/dist/index.js');
const theme={fg:(_color,text)=>text};
test('parent exposes only /herdr; keeps six compatible tools',()=>{
 const commands=[],tools=[];
 extension({registerTool:t=>tools.push(t.name),registerCommand:n=>commands.push(n),on(){}});
 assert.deepEqual(commands,['herdr']);assert.equal(tools.length,6);
});
test('child UI exposes no delegation tools and only /herdr',()=>{
 const commands=[],flags=[];
 childUI({registerFlag:n=>flags.push(n),registerCommand:n=>commands.push(n),on(){},exec(){throw Error('not called at factory time')}});
 assert.deepEqual(commands,['herdr']);assert.equal(flags.length,3);
});
test('fleet handles ANSI/CJK/long labels at narrow widths',()=>{
 const view=new FleetView();view.theme=theme;view.summary='2 运行 · 1 待答';
 view.rows=[{mark:'?',state:'blocked',label:'中文任务-long-name'.repeat(3),def:'reviewer',dur:'123m59s',flags:'ASK'}];
 for(const width of [1,12,24,40,70,80,120]) for(const line of view.render(width))assert.ok(visibleWidth(line)<=width,`${width}: ${line}`);
});
test('child cannot write agent definitions or pi-herdr config',async()=>{
 const handlers={};
 childUI({registerFlag(){},registerCommand(){},on:(name,fn)=>{handlers[name]=fn;},exec(){throw Error('not called')}});
 const guard=handlers['tool_call'];
 assert.equal(typeof guard,'function');
 assert.equal((await guard({toolName:'write',input:{path:'/root/.pi/agent/agents/evil.md'}}))?.block,true);
 assert.equal((await guard({toolName:'edit',input:{file_path:'C:\\Users\\u\\.pi\\agent\\agents/release.md'}}))?.block,true);
 assert.equal((await guard({toolName:'bash',input:{command:'echo x > ~/.pi/agent/agents/evil.md'}}))?.block,true);
 assert.equal((await guard({toolName:'read',input:{path:'/root/.pi/agent/agents/worker.md'}})),undefined);
 assert.equal((await guard({toolName:'write',input:{path:'/tmp/project/src/app.ts'}})),undefined);
 assert.equal((await guard({toolName:'bash',input:{command:'ls ~/.pi/agent/agents'}})),undefined);
});
test('palette search, keyboard selection, escape, mouse, narrow rendering',()=>{
 const entries=[{id:'a',label:'download',detail:'scout',action:'进入窗口'},{id:'b',label:'review',detail:'worker',action:'查看记录'}];
 let chosen;const p=new AgentPalette({requestRender(){},terminal:{rows:24}},theme,entries,'parent demo',e=>chosen=e);
 p.handleInput('worker');assert.equal(p.filtered().length,1);p.handleInput('\r');assert.equal(chosen.id,'b');
 for(const width of [12,40,80])for(const line of p.render(width))assert.ok(visibleWidth(line)<=width);
 p.handleInput('\x1b');assert.equal(chosen,undefined);
 const q=new AgentPalette({requestRender(){},terminal:{rows:24}},theme,entries,'parent demo',e=>chosen=e);q.render(80);
 q.handleMouse({type:'click',button:'left',x:2,y:4});assert.equal(chosen.id,'b');
});
test('focus uses live session identity, rejects foreign workspace, handles gone child',async()=>{
 const calls=[];let foreign=false,gone=false;
 const h=createHerdr(async(_cmd,args)=>{calls.push(args);return {code:0,stderr:'',stdout:JSON.stringify({result:args[0]==='pane'?{panes:[{pane_id:'p',workspace_id:'A',agent_session:{value:'/tmp/x_parent.jsonl'}},...(!gone?[{pane_id:'new-child-pane',workspace_id:foreign?'B':'A',agent_session:{value:'/tmp/x_child.jsonl'}}]:[])]}:{type:'ok'}})}});
 assert.equal(await h.focusSession('child','parent'),true);assert.deepEqual(calls.at(-1),['agent','focus','new-child-pane']);
 foreign=true;await assert.rejects(h.focusSession('child','parent'),/outside/);
 gone=true;assert.equal(await h.focusSession('child','parent'),false);
});
test('agent set merges user dir over packaged defaults without dropping fields',async()=>{
 const {mkdtemp,writeFile,mkdir}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {loadAgentSet}=await j.import('../src/agents.ts');
 const root=await mkdtemp(join(tmpdir(),'herdr-agents-'));
 const user=join(root,'user'),builtin=join(root,'builtin');await mkdir(user);await mkdir(builtin);
 await writeFile(join(builtin,'scout.md'),'---\nname: scout\ndescription: builtin scout\nmodel: m/builtin\nthinking: high\ntools: [read, write]\n---\n\nbuiltin body\n');
 await writeFile(join(builtin,'only-builtin.md'),'---\nname: only-builtin\ndescription: packaged only\ntools: [read]\n---\nbody\n');
 await writeFile(join(user,'scout.md'),'---\nname: scout\nmodel: m/user\n---\nuser body\n');
 await writeFile(join(user,'custom.md'),'---\nname: custom\ndescription: user role\nmodel: m/user\ntools: [read, bash]\n---\ncustom body\n');
 const set=await loadAgentSet(user,builtin);const byName=Object.fromEntries(set.map(d=>[d.name,d]));
 assert.deepEqual(Object.keys(byName).sort(),['custom','only-builtin','scout']);
 assert.equal(byName.scout.model,'m/user');
 assert.equal(byName.scout.description,'builtin scout');
 assert.deepEqual(byName.scout.tools,['read','write']);
 assert.equal(byName.scout.body,'user body');
 assert.equal(byName.custom.model,'m/user');
});
test('shared tab grows into a grid instead of slivers',async()=>{
 const {chooseSplitDirection}=await j.import('../src/herdr.ts');
 assert.equal(chooseSplitDirection(153,52),'right');
 assert.equal(chooseSplitDirection(77,52),'down');
 assert.equal(chooseSplitDirection(52,40),'down');
 assert.equal(chooseSplitDirection(200,60),'right');

 const calls=[];
 const h=createHerdr(async(_cmd,args)=>{calls.push(args);
  const reply=(result)=>({code:0,stderr:'',stdout:JSON.stringify({result})});
  if(args[0]==='pane'&&args[1]==='list')return reply({panes:[{pane_id:'p1',tab_id:'t1',workspace_id:'w1',agent_session:{value:'/s/x_abc.jsonl'}},{pane_id:'p2',tab_id:'t1',workspace_id:'w1'}]});
  if(args[0]==='tab'&&args[1]==='list')return reply({tabs:[{tab_id:'t1',workspace_id:'w1',label:'AGENTS · abc'}]});
  if(args[0]==='pane'&&args[1]==='layout')return reply({layout:{panes:[{pane_id:'p1',rect:{x:0,y:0,width:77,height:52}},{pane_id:'p2',rect:{x:77,y:0,width:76,height:52}}]}});
  if(args[0]==='pane'&&args[1]==='split')return reply({pane:{pane_id:'p3'}});
  throw new Error('unexpected '+args.join(' '));
 });
 const alloc=await h.allocateSessionPane('/tmp','abc');
 assert.equal(alloc.paneId,'p3');
 const split=calls.find(a=>a[0]==='pane'&&a[1]==='split');
 assert.ok(split.includes('down'),split.join(' '));
 assert.equal(split[split.indexOf('--pane')+1],'p1');
});
