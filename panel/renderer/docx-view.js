// Word documents in the preview: builds the page from what lib/docx.py read. Everything goes in
// with el() and textContent, never as HTML, so nothing in a document can run.

function docxRuns(parent, runs) {
  for (const run of runs) {
    if (run.br) {
      parent.append(run.br === 2 ? el('hr', 'docx-pagebreak') : document.createElement('br'));
    } else if (run.img) {
      const image = el('img', 'docx-img');
      image.src = run.img; // a data: address made by lib/docx.py
      if (run.w) image.style.width = `${run.w}px`;
      parent.append(image);
    } else {
      const piece = el(run.b ? 'strong' : 'span', '', run.x);
      if (run.i) piece.classList.add('docx-i');
      if (run.u) piece.classList.add('docx-u');
      parent.append(piece);
    }
  }
}

function docxBlocks(parent, blocks) {
  for (const block of blocks) {
    if (block.t === 'table') {
      const wrap = el('div', 'docx-table-wrap');
      const table = el('table', 'docx-table');
      for (const row of block.rows) {
        const tr = el('tr');
        for (const cell of row) {
          const td = el('td');
          docxBlocks(td, cell);
          tr.append(td);
        }
        table.append(tr);
      }
      wrap.append(table);
      parent.append(wrap);
      continue;
    }
    const heading = block.level > 0;
    const line = el(heading ? `h${block.level}` : 'p', heading ? 'docx-h' : 'docx-p');
    if (block.align) line.style.textAlign = block.align;
    if (block.list) {
      line.classList.add('docx-li');
      line.style.marginLeft = `${24 + block.depth * 24}px`;
      line.append(el('span', 'docx-mark', block.list), ' ');
    }
    docxRuns(line, block.runs);
    if (!heading && !block.list && !block.runs.length) line.classList.add('docx-empty'); // a blank line
    parent.append(line);
  }
}

function docxView(entry, { blocks, notes }) {
  const page = el('div', 'docx-view');
  docxBlocks(page, blocks);
  for (const note of notes) page.append(el('div', 'docx-note', note));
  return page;
}
