const MODEL = 'gpt-6-luna';

function keyOf(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es-AR').replace(/[^a-z0-9]+/g, ' ').trim();
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

async function structuredResponse(apiKey, name, schema, content) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, service_tier: 'fast', reasoning: { effort: 'low' },
        store: false, max_output_tokens: 3000,
        input: [{ role: 'user', content }],
        text: { format: { type: 'json_schema', name, strict: true, schema } }
      })
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error('OpenAI: ' + (error.error?.message || 'Error HTTP ' + response.status));
    }
    const result = await response.json();
    const text = result.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;
    if (!text) throw new Error('El modelo no devolvió una respuesta utilizable');
    return JSON.parse(text);
  } finally { clearTimeout(timeout); }
}

const rowSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string' }, kind: { type: 'string', enum: ['expense', 'income'] },
    amount: { type: 'number' }, currency: { type: 'string', enum: ['ARS', 'USD', 'UNKNOWN'] },
    date: { type: 'string' }, time: { type: ['string', 'null'] },
    categoryId: { type: ['string', 'null'] }, include: { type: 'boolean' },
    reason: { type: ['string', 'null'] }
  },
  required: ['title', 'kind', 'amount', 'currency', 'date', 'time', 'categoryId', 'include', 'reason']
};

const extractionSchema = {
  type: 'object', additionalProperties: false,
  properties: { rows: { type: 'array', items: rowSchema } }, required: ['rows']
};

async function extractBatch({ apiKey, images, caption, categories, rules, existing, today }) {
  const categoryList = categories.map((item) => ({ id: item.id, name: item.name, kind: item.kind }));
  const instructions = [
    'Extraé movimientos financieros de las imágenes o del mensaje. Respondé solo según el esquema JSON.',
    'Cada fila visible es un movimiento distinto. No inventes filas cortadas ni importes ilegibles.',
    'amount siempre es positivo. El signo menos de la captura indica kind=expense y el signo más indica kind=income.',
    'Los importes usan formato argentino: 1.197,05 significa 1197.05. Usá fecha visible, no la fecha actual cuando la imagen indique otra.',
    'Elegí solamente categoryId de la lista. Si no hay una opción clara, usá null e include=false.',
    'Si el mensaje pide ignorar un comercio o fila, devolvela con include=false y reason="Ignorado por indicación del usuario".',
    'Tarjeta de crédito, cuotas que se pagarán como un único gasto, cargos USD y transferencias entre cuentas propias: include=false.',
    'Un ingreso de origen incierto o una transferencia a una persona sin regla conocida: include=false hasta que el usuario aclare.',
    'No conviertas USD a ARS. Para ARS, conservá el valor con decimales; la app redondeará al peso al guardar.',
    'Máximo 30 filas. Usá nombres cortos y reconocibles como título.',
    'Fecha actual: ' + today,
    'Categorías: ' + JSON.stringify(categoryList),
    'Reglas conocidas: ' + JSON.stringify(rules),
    'Mensaje del usuario: ' + (caption || '(solo imagen)')
  ].join('\n');
  const content = [{ type: 'input_text', text: instructions }];
  images.forEach((image) => content.push({ type: 'input_image', image_url: 'data:' + image.mime + ';base64,' + image.bytes.toString('base64'), detail: 'original' }));
  const output = await structuredResponse(apiKey, 'misgastos_movimientos', extractionSchema, content);
  if (!Array.isArray(output.rows) || output.rows.length > 30) throw new Error('La captura contiene demasiados movimientos');
  const categoryMap = new Map(categories.map((item) => [item.id, item]));
  const ruleMap = new Map(rules.map((rule) => [keyOf(rule.merchant), rule.categoryId]));
  const ignorePhrase = String(caption || '').match(/(?:ignora|ignorá|omite|omití)\s+(?:el|la|los|las|lo de)?\s*([^.,;\n]+)/i)?.[1];
  const ignoreKey = keyOf(ignorePhrase);
  const seen = new Set();
  return output.rows.map((item) => {
    const title = String(item.title || '').trim().slice(0, 80);
    const dateKnown = validDate(item.date);
    const date = dateKnown ? item.date : today;
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(item.time || '') ? item.time : null;
    const amount = Math.round(Number(item.amount));
    const currency = item.currency;
    const ruleCategory = item.kind === 'expense' ? ruleMap.get(keyOf(title)) : null;
    const categoryId = ruleCategory || item.categoryId;
    const category = categoryMap.get(categoryId);
    let reason = item.reason ? String(item.reason).slice(0, 120) : '';
    let include = ruleCategory && !/ignorad|omitid|tarjeta/i.test(reason) ? true : item.include === true;
    if (!dateKnown) { include = false; reason = 'Fecha por confirmar'; }
    if (!title || !Number.isSafeInteger(amount) || amount <= 0) { include = false; reason = 'Importe o concepto ilegible'; }
    if (currency !== 'ARS') { include = false; reason = currency === 'USD' ? 'Gasto en USD para cargar con la tarjeta' : 'Moneda incierta'; }
    if (/tarjeta de cr[eé]dito|cr[eé]ditos? de mercado pago|pago de cuotas/i.test(title + ' ' + reason)) { include = false; reason = 'Tarjeta o cuota para cargar por separado'; }
    if (ignoreKey && (keyOf(title).includes(ignoreKey) || ignoreKey.includes(keyOf(title)))) { include = false; reason = 'Ignorado por indicación tuya'; }
    if (!category || category.kind !== item.kind || categoryId === 'savings' || categoryId === 'savings-return') { include = false; reason ||= 'Categoría por confirmar'; }
    const fingerprint = [keyOf(title), item.kind, date, amount, time || ''].join('|');
    if (seen.has(fingerprint)) { include = false; reason = 'Posible repetido en la captura'; }
    seen.add(fingerprint);
    if (existing.some((entry) => keyOf(entry.title) === keyOf(title) && entry.kind === item.kind && entry.date === date && entry.amount === amount)) {
      include = false; reason = 'Posible movimiento ya cargado';
    }
    return { title, kind: item.kind, amount, currency, date, time, categoryId: category?.kind === item.kind ? categoryId : null, include, reason };
  });
}

const correctionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['ignore', 'include', 'category', 'remember', 'unknown'] },
    index: { type: 'integer' }, categoryId: { type: ['string', 'null'] },
    merchant: { type: ['string', 'null'] }, remember: { type: 'boolean' }
  },
  required: ['action', 'index', 'categoryId', 'merchant', 'remember']
};

async function interpretCorrection({ apiKey, message, batch, categories }) {
  const content = [{ type: 'input_text', text: [
    'Interpretá una corrección para un lote de movimientos. Devolvé solo el esquema JSON.',
    'index es el número de fila (1 en adelante). Si dice ignorá una fila, action=ignore.',
    'Si dice poné una fila en otra categoría, action=category. Si dice recordá que un destinatario pertenece a una categoría, action=remember.',
    'Una regla puede crearse sin filas pendientes. En ese caso usá index=0, merchant con el nombre del comercio y la categoría existente más adecuada; por ejemplo, un verdulero corresponde a Comida.',
    'Solo usá categoryId de la lista. Cuando no puedas identificar fila o categoría, action=unknown.',
    'Para recordar una regla, merchant debe ser el nombre exacto del destinatario o comercio y remember=true.',
    'Si la instrucción cambia una fila y quiere que se recuerde para el futuro, action=category y remember=true.',
    'Categorías: ' + JSON.stringify(categories.map((item) => ({ id: item.id, name: item.name, kind: item.kind }))),
    'Filas: ' + JSON.stringify(batch.rows.map((row, index) => ({ index: index + 1, title: row.title, amount: row.amount, categoryId: row.categoryId, include: row.include }))),
    'Instrucción: ' + message
  ].join('\n') }];
  return structuredResponse(apiKey, 'misgastos_correccion', correctionSchema, content);
}

module.exports = { extractBatch, interpretCorrection, keyOf, validDate };
