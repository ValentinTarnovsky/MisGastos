const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MODEL = 'gpt-6-luna';
const CODEX_TIMEOUT_MS = 180000;

function keyOf(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es-AR').replace(/[^a-z0-9]+/g, ' ').trim();
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function codexExecutable() {
  const installed = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  return installed && fs.existsSync(installed) ? installed : 'codex';
}

async function runCodex(schema, prompt, images = []) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'misgastos-codex-'));
  const schemaPath = path.join(folder, 'schema.json');
  const outputPath = path.join(folder, 'result.json');
  try {
    fs.writeFileSync(schemaPath, JSON.stringify(schema), 'utf8');
    const imagePaths = images.map((image, index) => {
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[image.mime];
      if (!extension || !Buffer.isBuffer(image.bytes)) throw new Error('Formato de captura no válido');
      const imagePath = path.join(folder, 'capture-' + index + '.' + extension);
      fs.writeFileSync(imagePath, image.bytes);
      return imagePath;
    });
    const args = [
      'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'hooks', '--disable', 'multi_agent',
      '--sandbox', 'read-only', '-C', folder, '-m', MODEL,
      '-c', 'model_reasoning_effort="low"', '-c', 'service_tier="fast"',
      '--output-schema', schemaPath, '-o', outputPath, '--color', 'never'
    ];
    if (imagePaths.length) args.push('--image', ...imagePaths);
    args.push('-');
    const environment = { ...process.env };
    delete environment.OPENAI_API_KEY;
    delete environment.CODEX_API_KEY;
    await new Promise((resolve, reject) => {
      const child = spawn(codexExecutable(), args, { cwd: folder, env: environment, windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'pipe'] });
      let settled = false;
      let timedOut = false;
      let errorOutput = '';
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error); else resolve();
      };
      const timeout = setTimeout(() => { timedOut = true; child.kill(); }, CODEX_TIMEOUT_MS);
      child.stderr.on('data', (chunk) => { errorOutput = (errorOutput + chunk.toString()).slice(-4000); });
      child.on('error', () => finish(new Error('No encuentro Codex CLI en esta PC. Instalalo e iniciá sesión con ChatGPT.')));
      child.on('close', (code) => {
        if (timedOut) finish(new Error('Codex CLI tardó demasiado. Probá de nuevo.'));
        else if (code === 0) finish();
        else {
          const loginProblem = /not logged in|authentication|unauthorized|login required/i.test(errorOutput);
          finish(new Error(loginProblem ? 'Iniciá sesión en Codex CLI con tu cuenta de ChatGPT.' : 'Codex CLI no pudo analizar el mensaje. Revisá tu conexión o el límite de uso e intentá de nuevo.'));
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
    if (!fs.existsSync(outputPath)) throw new Error('Codex CLI no devolvió una respuesta utilizable');
    return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
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

async function extractBatch({ images, caption, categories, rules, existing, today, referenceRows = [], runStructured = runCodex }) {
  const categoryList = categories.map((item) => ({ id: item.id, name: item.name, kind: item.kind }));
  const instructions = [
    'Extraé movimientos financieros de las imágenes o del mensaje. Respondé solo según el esquema JSON.',
    'Cada fila visible es un movimiento distinto. No inventes filas cortadas ni importes ilegibles.',
    'amount siempre es positivo. El signo menos de la captura indica kind=expense y el signo más indica kind=income.',
    'Los importes usan formato argentino: 1.197,05 significa 1197.05. Usá fecha visible, no la fecha actual cuando la imagen indique otra.',
    'Elegí solamente categoryId de la lista. Si no hay una opción clara, usá null e include=false.',
    'Si el mensaje pide ignorar un comercio o fila, devolvela con include=false y reason="Ignorado por indicación del usuario".',
    'En capturas, excluí cargos de tarjeta, cuotas que se pagarán como un único gasto, cargos USD y transferencias entre cuentas propias.',
    'Si el usuario escribe expresamente un pago único de tarjeta o cuotas como gasto nuevo, proponelo en ARS con la categoría de Crédito si existe. No lo excluyas solo por ser de tarjeta.',
    'Si el usuario se refiere a una fila anterior sin repetir el importe, usá las filas de referencia solo cuando el comercio coincida claramente. Priorizá el nombre sobre un número de fila ambiguo. Conservá importe y fecha originales. Si no podés identificarla, devolvé rows=[].',
    'Un ingreso de origen incierto o una transferencia a una persona sin regla conocida: include=false hasta que el usuario aclare.',
    'No conviertas USD a ARS. Para ARS, conservá el valor con decimales; la app redondeará al peso al guardar.',
    'Máximo 30 filas. Usá nombres cortos y reconocibles como título.',
    'Fecha actual: ' + today,
    'Categorías: ' + JSON.stringify(categoryList),
    'Reglas conocidas: ' + JSON.stringify(rules),
    'Filas anteriores de referencia: ' + JSON.stringify(referenceRows.map((row) => ({ title: row.title, kind: row.kind, amount: row.amount, currency: row.currency, date: row.date, time: row.time, categoryId: row.categoryId }))),
    'Mensaje del usuario: ' + (caption || '(solo imagen)')
  ].join('\n');
  const output = await runStructured(extractionSchema, instructions, images);
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
    if (images.length && /tarjeta de cr[eé]dito|cr[eé]ditos? de mercado pago|pago de cuotas|cuotas? mercado pago/i.test(title + ' ' + reason)) { include = false; reason = 'Tarjeta o cuota para cargar por separado'; }
    if (!images.length && item.kind === 'expense' && dateKnown && Number.isSafeInteger(amount) && amount > 0 && currency === 'ARS' && category?.kind === 'expense' && /tarjeta|cuot|cr[eé]dit/i.test(title) && !/(?:ignora|omit[ií])/i.test(caption || '')) { include = true; reason = ''; }
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
    edits: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['update', 'ignore', 'include', 'remember'] },
          index: { type: 'integer' }, categoryId: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] }, merchant: { type: ['string', 'null'] },
          remember: { type: 'boolean' }
        },
        required: ['action', 'index', 'categoryId', 'title', 'merchant', 'remember']
      }
    }
  },
  required: ['edits']
};

async function interpretCorrections({ message, batch, categories, runStructured = runCodex }) {
  const prompt = [
    'Interpretá TODAS las correcciones del mensaje para un lote de movimientos. Devolvé una edición por cada fila mencionada, incluso si el usuario escribe varias instrucciones breves como "1 ropa 2 verdulería 3 ingreso extra ponele Trabajo Pintura". No te quedes solo con la primera.',
    'index es el número de fila (1 en adelante). action=update puede cambiar categoría y título juntos. categoryId=null o title=null significa conservar ese campo.',
    'Si dice "ponerle de nombre", "que sea" o "llamalo", poné el nuevo título exacto en title. No mantengas el nombre de la persona cuando pide reemplazarlo por un concepto.',
    'Si nombra una categoría existente, elegí su categoryId y dejá title=null salvo que pida cambiar el nombre. "1 ropa" solo cambia categoría a Ropa.',
    'Si usa un concepto que no es categoría existente, como "verdulería" o "costurera", elegí una categoría existente apropiada para el tipo de fila y usá ese concepto como título. Verdulería va en Comida; costurera va en Ropa si existen.',
    '"Ingreso extra" corresponde a una categoría de ingreso como Otros ingresos, nunca a una categoría de gasto llamada Extras. Si agrega "ponele Trabajo Pintura", title="Trabajo Pintura".',
    'Si pide ignorar una fila, action=ignore. Si pide incluir una fila sin cambiarla, action=include.',
    'Una regla se puede recordar sin filas pendientes: action=remember, index=0, merchant con el nombre exacto del comercio o destinatario y categoryId de una categoría de gasto.',
    'Para cambios de filas, merchant=null normalmente; remember=true solo si pide expresamente recordar para el futuro. No inventes filas ni categorías. Si algo es ambiguo, omití esa edición.',
    'Devolvé edits=[] cuando no haya ninguna corrección identificable.',
    'Categorías: ' + JSON.stringify(categories.map((item) => ({ id: item.id, name: item.name, kind: item.kind }))),
    'Filas: ' + JSON.stringify(batch.rows.map((row, index) => ({ index: index + 1, title: row.title, kind: row.kind, amount: row.amount, categoryId: row.categoryId, include: row.include }))),
    'Instrucción: ' + message
  ].join('\n');
  const result = await runStructured(correctionSchema, prompt);
  if (!Array.isArray(result.edits) || result.edits.length > 30) throw new Error('No pude interpretar todas las correcciones');
  return result.edits;
}

module.exports = { extractBatch, interpretCorrections, runCodex, keyOf, validDate };
