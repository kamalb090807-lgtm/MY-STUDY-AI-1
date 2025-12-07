function renderCurrent(){
        const conv = getCurrentConv();
        if(!conv) return;
        document.getElementById('chat-title').textContent = conv.title || 'My STUDY AI';
        messagesEl.innerHTML = '';
        for (const m of conv.messages) {
          const b = document.createElement('div');
          b.className = 'bubble ' + (m.from === 'user' ? 'user' : 'ai');

          // content container (for easier injection)
          const content = document.createElement('div');
          content.className = 'bubble-content';

          const rawText = typeof m.text === 'string' ? m.text : String(m.text);
          // Detect LaTeX blocks (display math $$...$$, or \(...\), \[...\])
          const latexRegex = /(\$\$[\s\S]*?\$\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g;
          if (latexRegex.test(rawText)) {
            // Preserve LaTeX blocks: replace them with placeholders, sanitize the rest, then restore
            const placeholderPrefix = '___LATEXPH_';
            const latexParts = [];
            const replaced = rawText.replace(latexRegex, (m0)=>{ latexParts.push(m0); return `${placeholderPrefix}${latexParts.length-1}___`; });

            // Run markdown+sanitize on non-latex parts
            const html = marked.parse(replaced);
            const safe = DOMPurify.sanitize(html);

            // Put sanitized HTML into a temp container
            const tmp = document.createElement('div');
            tmp.innerHTML = safe;

            // Replace placeholders in text nodes with nodes that preserve LaTeX raw text
            function replacePlaceholders(node){
              if(node.nodeType === Node.TEXT_NODE){
                const txt = node.nodeValue || '';
                if(txt.indexOf(placeholderPrefix) === -1) return;
                const frag = document.createDocumentFragment();
                let lastIndex = 0;
                const tokenRe = new RegExp(placeholderPrefix + '(\\d+)___','g');
                let mtok;
                let currIndex = 0;
                while((mtok = tokenRe.exec(txt)) !== null){
                  const idx = mtok.index;
                  const pre = txt.slice(lastIndex, idx);
                  if(pre) frag.appendChild(document.createTextNode(pre));
                  const id = parseInt(mtok[1],10);
                  const wrap = document.createElement('div');
                  wrap.className = 'latex-block';
                  // Use textContent so backslashes and dollar signs are preserved
                  wrap.textContent = latexParts[id];
                  frag.appendChild(wrap);
                  lastIndex = tokenRe.lastIndex;
                }
                const tail = txt.slice(lastIndex);
                if(tail) frag.appendChild(document.createTextNode(tail));
                node.parentNode.replaceChild(frag, node);
                return;
              }
              // Recurse
              for(const child of Array.from(node.childNodes)) replacePlaceholders(child);
            }
                // place processed HTML into content
                content.appendChild(tmp);
              } else {
                // no latex - just render sanitized markdown
                content.innerHTML = DOMPurify.sanitize(marked.parse(rawText));
              }

              // Action buttons container (add-note, etc.)
              const actions = document.createElement('div');
              actions.className = 'bubble-actions';
              actions.style.display = 'flex'; actions.style.gap = '8px'; actions.style.marginTop = '8px';

              // Add 'Add note' button for AI messages (also available via top bar)
              if (m.from !== 'user'){
                const noteBtn = document.createElement('button');
                noteBtn.className = 'msg-action-btn';
                noteBtn.title = 'Add this message to notes';
                noteBtn.textContent = '📝';
                noteBtn.addEventListener('click', (ev)=>{
                  ev.stopPropagation();
                  const tmp = document.createElement('div'); tmp.innerHTML = m.text || '';
                  const plainText = (tmp.textContent || tmp.innerText || String(m.text)).trim();
                  addNote(plainText);
                  noteBtn.style.background = 'rgba(106,209,255,0.2)';
                  setTimeout(()=> noteBtn.style.background = '', 600);
                });
                actions.appendChild(noteBtn);
              }

              // append content and actions
              b.appendChild(content);
              b.appendChild(actions);

            replacePlaceholders(tmp);
            // Append processed children to content
            while(tmp.firstChild) content.appendChild(tmp.firstChild);
          } else {
            // Normal path: markdown -> sanitize -> insert
            const safe = DOMPurify.sanitize(marked.parse(rawText));
            content.innerHTML = safe;
          }

          b.appendChild(content);
          messagesEl.appendChild(b);
        }