const fs = require('fs');
const path = require('path');
const file = path.resolve(__dirname, '..', 'frontend', 'index.html');
const txt = fs.readFileSync(file,'utf8');
// extract first <script>...</script>
const m = txt.match(/<script[^>]*>([\s\S]*)<\/script>/i);
if(!m){ console.log('No <script> block found'); process.exit(1); }
const script = m[1];
function countChars(s,ch){return (s.split(ch).length-1);} 
console.log('Totals in inline <script>:');
console.log('{', countChars(script,'{'), '} ', countChars(script,'}'));
console.log('(', countChars(script,'('), ') ', countChars(script,')'));
console.log('[', countChars(script,'['), '] ', countChars(script,']'));
console.log('single quotes', countChars(script,"'"), 'double quotes', countChars(script,'"'), 'backticks', countChars(script,'`'));

// Find lines containing 'else' and print context
const lines = script.split(/\n/);
for(let i=0;i<lines.length;i++){
  if(/\belse\b/.test(lines[i])){
    console.log('\n--- else at line', i+1, '---');
    for(let j=Math.max(0,i-3); j<=Math.min(lines.length-1,i+3); j++){
      console.log((j+1).toString().padStart(4)+': '+lines[j]);
    }
  }
}

// Find unclosed block by running a simple stack for braces
const stack = [];
const opening = {'{':'}','(' : ')', '[':']'};
const closing = {'}':'{', ')':'(', ']':'['};
for(let i=0;i<lines.length;i++){
  const line = lines[i];
  for(let chIdx=0; chIdx<line.length; chIdx++){
    const ch = line[chIdx];
    if(opening[ch]) stack.push({ch, line: i+1, col: chIdx+1});
    else if(closing[ch]){
      if(stack.length === 0){ console.log('Unmatched closing', ch, 'at', i+1, chIdx+1); }
      else{
        const top = stack[stack.length-1];
        if(top.ch === closing[ch]) stack.pop();
        else{ console.log('Mismatched closing', ch, 'at', i+1, chIdx+1, 'expected', opening[top.ch]); }
      }
    }
  }
}
if(stack.length>0){ console.log('\nUnclosed openings:'); stack.slice(0,10).forEach(s=> console.log(s.ch, 'opened at', s.line, s.col)); }
else console.log('\nAll braces/paren/brackets appear balanced (textually).');
