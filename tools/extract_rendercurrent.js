const fs = require('fs');
const path = require('path');
const file = path.resolve(__dirname, '..', 'frontend', 'index.html');
const txt = fs.readFileSync(file,'utf8');
const re = /<script[^>]*>([\s\S]*?)<\/script>/ig;
let m; const scripts = [];
while((m = re.exec(txt)) !== null) scripts.push({text:m[1], index: m.index});
let target = null; let baseIndex = 0;
for(const s of scripts){ if(s.text.indexOf('function renderCurrent(') !== -1){ target = s.text; baseIndex = s.index; break; } }
if(!target){ console.error('renderCurrent not found'); process.exit(1); }
const pos = target.indexOf('function renderCurrent(');
let i = pos;
// find opening brace of function
while(i<target.length && target[i] !== '{') i++;
if(i>=target.length){ console.error('No opening brace after function'); process.exit(1); }
let stack = [];
let start = i;
for(let j=i;j<target.length;j++){
  const ch = target[j];
  if(ch === '{') stack.push(j);
  else if(ch === '}'){
    stack.pop();
    if(stack.length === 0){
      const funcText = target.slice(pos, j+1);
      // write to file for inspection
      const out = path.resolve(__dirname, '..', 'tools', 'renderCurrent_extracted.js');
      fs.writeFileSync(out, funcText, 'utf8');
      console.log('Wrote function to', out, 'length', funcText.split(/\n/).length, 'lines');
      process.exit(0);
    }
  }
}
console.error('Could not find matching closing brace for function');
process.exit(2);
