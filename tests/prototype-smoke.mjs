// Logic smoke test with a DOM stub. Does not validate browser layout or accessibility.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../design/prototype.html',import.meta.url),'utf8');
const elements=new Map();
function el(){const classes=new Set();return {innerHTML:'',textContent:'',style:{},children:[],classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle(x,on){if(on===undefined)on=!classes.has(x);on?classes.add(x):classes.delete(x);}},appendChild(x){this.children.push(x)},scrollIntoView(){}};}
const document={getElementById(id){if(!elements.has(id))elements.set(id,el());return elements.get(id)},createElement:el};
const ctx=vm.createContext({document,window:{addEventListener(){}},console});
const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
vm.runInContext(script,ctx);
const run=s=>vm.runInContext(s,ctx);
run("setScenario('mixed')");assert.match(document.getElementById('fleet-widget').innerHTML,/schema-sync/);
run('toggleWidth()');assert.equal(run('currentWidth'),40);
run("setScenario('alldone'); stepTime(30)");assert.equal(document.getElementById('fleet-widget').innerHTML,'');
run('simulateReload()');assert.equal(document.getElementById('fleet-widget').innerHTML,'');
run("setScenario('error'); stepTime(60)");assert.match(document.getElementById('fleet-widget').innerHTML,/sftp-image/);
run('toggleHistory()');assert.equal(document.getElementById('history-table-body').children.length,8);
console.log('PASS: mixed, narrow, completion expiry, reload, persistent errors, history (DOM stub only)');
