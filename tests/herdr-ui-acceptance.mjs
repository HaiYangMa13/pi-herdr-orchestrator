// Opt-in integration test: creates two dedicated Pi panes, never sends a model task.
import {fileURLToPath as _f} from "node:url";
const selfIndex=_f(new URL("../index.ts",import.meta.url));
const selfChild=_f(new URL("../child-ui.ts",import.meta.url));
import {createJiti} from '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const exec=promisify(execFile),j=createJiti(import.meta.url);
const {createHerdr}=await j.import('../src/herdr.ts');
const run=async(args)=>{try{const r=await exec('herdr',args,{timeout:100_000});return r.stdout.trim()?JSON.parse(r.stdout):{};}catch(e){throw Error((e.stderr||e.stdout||e.message).slice(-1000));}};
const h=createHerdr(async(cmd,args)=>{try{const r=await exec(cmd,args,{timeout:100_000});return {...r,code:0};}catch(e){return {stdout:e.stdout||'',stderr:e.stderr||'',code:e.code||1};}});
const original=(await run(['pane','current','--current'])).result.pane;
const parentId=randomUUID(),childId=randomUUID(),suffix=parentId.slice(0,6);
let parent,child;const parentName='uitest-main-'+suffix,childName='uitest-child-'+suffix;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const text=async(p,s)=>run(['pane','send-text',p,s]);
const keys=async(n,...k)=>run(['agent','send-keys',n,...k]);
const capture=async(n,path)=>{const r=await exec('herdr',['agent','read',n,'--source','visible']);await writeFile(path,r.stdout);return r.stdout;};
try{
 parent=await h.createTab('/tmp','pi-herdr-ui-test',undefined,original.workspace_id);
 await h.start(parentName,parent.paneId,['--no-extensions','--no-skills','--extension','/root/.pi/agent/extensions/herdr-agent-state.ts','--extension',selfIndex,'--model','local-cpa/gpt-6.1-sol','--session-id',parentId]);
 await wait(1800);
 const snapshot=(await run(['pane','list'])).result.panes.find(p=>p.pane_id===parent.paneId);
 console.log('Parent identity:',JSON.stringify({expected:parentId,pane:snapshot}));
 await capture(parentName,'/tmp/pi-herdr-parent-start.txt');
 child=await h.allocateSessionPane('/tmp',parentId);
 await h.start(childName,child.paneId,['--no-extensions','--no-skills','--extension','/root/.pi/agent/extensions/herdr-agent-state.ts','--extension',selfChild,'--herdr-parent',parentId,'--herdr-label','live-demo','--herdr-role','scout','--model','local-cpa/gpt-6.1-sol','--session-id',childId]);
 await h.renamePane(child.paneId,`SUB · live-demo · scout · parent ${parentId.slice(0,8)}`);
 const root='/root/.pi/agent/pi-herdr/runs/'+parentId;
 for(const label of ['live-demo','archived-demo']){
  const dir=root+'/'+label;await mkdir(dir,{recursive:true});
  await writeFile(dir+'/meta.json',JSON.stringify({label,herdrName:label==='live-demo'?childName:'old-demo',definition:'scout',paneId:label==='live-demo'?child.paneId:'gone',tabId:child.tabId,piSessionId:label==='live-demo'?childId:randomUUID(),cwd:'/tmp',startedAt:Date.now()-60_000,endedAt:Date.now()-35_000,state:label==='live-demo'?'blocked':'done',keepAlive:true}));
  if(label==='archived-demo')await writeFile(dir+'/result.md','# UI acceptance result\nRESULT_VIEW_OK\nNo model task was executed.');
 }
 await wait(2500);
 await text(parent.paneId,'/herdr');await keys(parentName,'enter');await wait(1000);
 const menu=await capture(parentName,'/tmp/pi-herdr-menu.txt');assert.ok(menu.includes('live-demo'),menu.slice(-500));
 await text(parent.paneId,'live-demo');await keys(parentName,'enter');await wait(700);
 let agents=await h.list();assert.equal(agents.find(a=>a.pane_id===child.paneId)?.focused,true);
 await capture(childName,'/tmp/pi-herdr-child.txt');
 await text(child.paneId,'/herdr');await keys(childName,'enter');await wait(700);
 await text(child.paneId,'MAIN');await keys(childName,'enter');await wait(700);
 agents=await h.list();assert.equal(agents.find(a=>a.pane_id===parent.paneId)?.focused,true);
 await text(parent.paneId,'/herdr');await keys(parentName,'enter');await wait(700);
 await text(parent.paneId,'Archive');await keys(parentName,'enter');await wait(700);
 await text(parent.paneId,'archived-demo');await keys(parentName,'enter');await wait(700);
 const result=await capture(parentName,'/tmp/pi-herdr-result.txt');assert.ok(result.includes('RESULT_VIEW_OK'),result.slice(-500));
 await keys(parentName,'esc');await wait(200);await keys(parentName,'esc');
 console.log('PASS REAL HERDR: parent palette -> child focus; child palette -> main focus; archived result viewer. No model requests.');
}finally{
 if(child)await h.kill(childName,child.paneId);
 if(parent)await h.kill(parentName,parent.paneId);
 await run(['agent','focus',original.pane_id]).catch(()=>{});
 console.log('Test panes cleaned; original focus restored. Test session:',parentId);
}
