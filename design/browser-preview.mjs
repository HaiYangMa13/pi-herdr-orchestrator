// Local prototype verification using an isolated headless Edge profile on port 9224.
import fs from 'node:fs/promises';
const pages=await (await fetch('http://127.0.0.1:9224/json/list')).json();
const page=pages.find(p=>p.type==='page');
if(!page)throw Error('No preview page');
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
let seq=0;const pending=new Map();
ws.addEventListener('message',e=>{const msg=JSON.parse(e.data);const p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result);}});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
export async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
export async function screenshot(path){const r=await call('Page.captureScreenshot',{format:'jpeg',quality:75});await fs.writeFile(path,Buffer.from(r.data,'base64'));}
export async function resize(width,height){await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});}
export async function navigate(url){await call('Page.enable');await call('Page.navigate',{url});await new Promise(r=>setTimeout(r,1200));}
export async function key(key,code=key){await call('Input.dispatchKeyEvent',{type:'keyDown',key,code});await call('Input.dispatchKeyEvent',{type:'keyUp',key,code});}
export function close(){ws.close();}
