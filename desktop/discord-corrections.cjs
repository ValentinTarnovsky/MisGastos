function mentionedRows(message, count) {
  const indexes = new Set();
  const pattern = /(?:^|[\s,;])(?:(?:fila|el|la)\s+)?(\d{1,2})(?=\s|[.,;:]|$)/gi;
  for (const match of String(message).matchAll(pattern)) {
    const index = Number(match[1]);
    if (index >= 1 && index <= count) indexes.add(index);
  }
  return indexes;
}

function applyCorrections({ message, rows, categories, edits }) {
  if (!Array.isArray(edits) || !edits.length) throw new Error('No entendí qué cambiar. Indicá los números de fila y qué querés hacer con cada una.');
  const requested = mentionedRows(message, rows.length);
  const changed = new Set();
  const nextRows = rows.map((row) => ({ ...row }));
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const rules = new Map();

  for (const edit of edits) {
    if (!edit || !['update', 'ignore', 'include', 'remember'].includes(edit.action) || !Number.isInteger(edit.index)) throw new Error('No pude interpretar una de las correcciones');
    const category = edit.categoryId == null ? null : categoryMap.get(edit.categoryId);
    if (edit.action === 'remember') {
      const merchant = String(edit.merchant || '').trim();
      if (edit.index !== 0 || !merchant || merchant.length > 80 || !category || category.kind !== 'expense') throw new Error('No pude identificar el comercio y su categoría para recordarlos');
      rules.set(merchant, category.id);
      continue;
    }
    const row = nextRows[edit.index - 1];
    if (!row || (requested.size && !requested.has(edit.index))) throw new Error('No pude identificar una de las filas mencionadas');
    const originalTitle = rows[edit.index - 1].title;
    changed.add(edit.index);

    if (edit.action === 'ignore') {
      row.include = false;
      row.reason = 'Ignorado por indicación tuya';
      continue;
    }
    if (edit.action === 'include') {
      if (row.currency !== 'ARS' || categoryMap.get(row.categoryId)?.kind !== row.kind) throw new Error('Primero indicá una categoría válida en ARS para la fila ' + edit.index);
      row.include = true;
      row.reason = '';
      continue;
    }

    const title = edit.title == null ? null : String(edit.title).trim();
    if (title !== null && (!title || title.length > 80)) throw new Error('El nombre de la fila ' + edit.index + ' no es válido');
    if (edit.categoryId != null && (!category || category.kind !== row.kind || ['savings', 'savings-return'].includes(category.id))) throw new Error('No encontré una categoría válida para la fila ' + edit.index);
    if (!category && title === null) throw new Error('No pude interpretar el cambio de la fila ' + edit.index);
    if (category) row.categoryId = category.id;
    if (title !== null) row.title = title;
    const validCategory = categoryMap.get(row.categoryId)?.kind === row.kind;
    const needsReview = row.currency !== 'ARS' || /tarjeta|cuota|usd|d[oó]lar|repetid|ya cargado|moneda|fecha|ilegible/i.test(row.reason || '');
    if (validCategory && !needsReview) { row.include = true; row.reason = ''; }
    if (row.kind === 'expense' && validCategory && (edit.remember === true || (category && !/solo esta vez/i.test(message)))) {
      rules.set(originalTitle, row.categoryId);
    }
  }

  const missing = [...requested].filter((index) => !changed.has(index));
  if (missing.length) throw new Error('No pude interpretar la' + (missing.length === 1 ? ' fila ' : 's filas ') + missing.join(', ') + '. No cambié ninguna fila.');
  return { rows: nextRows, changed: [...changed].sort((a, b) => a - b), rules: [...rules].map(([merchant, categoryId]) => ({ merchant, categoryId })) };
}

module.exports = { applyCorrections, mentionedRows };
