const fs = require('fs');
const path = require('path');
const vm = require('vm');
const file = path.resolve(__dirname, '..', 'frontend', 'index.html');
const txt = fs.readFileSync(file,'utf8');
// Find the <script> block that contains the main IIFE '(function()' or 'window.MYSTUDY_STORE'
const scriptBlocks = [];
const re = /<script[^>]*>([\s\S]*?)<\/script>/ig;
let m;
while((m = re.exec(txt)) !== null){ scriptBlocks.push(m[1]); }
let target = null; let idx = -1;
for(let i=0;i<scriptBlocks.length;i++){
  const s = scriptBlocks[i];
  if(s.indexOf('(function(') !== -1 || s.indexOf('window.MYSTUDY_STORE') !== -1){ target = s; idx = i; break; }
}
if(!target){ console.error('Could not find target inline script'); process.exit(2); }
console.log('Found target script block index', idx, 'length', target.split('\n').length, 'lines');
try{
  new vm.Script(target, {filename: 'extracted_script.js'});
  console.log('No syntax errors detected by Node parser.');
} catch(err){
  console.error('Parser error:', err.message);
  const locMatch = err.stack && err.stack.match(/extracted_script.js:(\d+):(\d+)/);
  let line = null;
  let col = null;
  if(locMatch){ line = parseInt(locMatch[1],10); col = parseInt(locMatch[2],10); }
  else {
    const locMatch2 = err.stack && err.stack.match(/extracted_script.js:(\d+)/);
    if(locMatch2) line = parseInt(locMatch2[1],10);
  }
  if(line){
    console.error('Error at line', line, col ? ('col ' + col) : '');
    const lines = target.split(/\n/);
    const start = Math.max(0, line-6);
    const end = Math.min(lines.length, line+3);
    console.error('--- Context ---');
    for(let i=start;i<end;i++){
      const mark = (i+1 === line) ? '>>' : '  ';
      console.error(`${mark} ${i+1}: ${lines[i]}`);
    }
  } else {
    console.error('Could not parse error location from stack. Full stack:\n', err.stack);
  }
  process.exit(1);
}
