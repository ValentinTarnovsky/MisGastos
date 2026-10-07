const { Client, Events, GatewayIntentBits } = require('discord.js');
const { extractBatch, interpretCorrections } = require('./discord-ai.cjs');
const { applyCorrections } = require('./discord-corrections.cjs');

function formatAmount(amount) { return '$' + Number(amount).toLocaleString('es-AR'); }

function todayInArgentina() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type) => parts.find((item) => item.type === type).value;
  return part('year') + '-' + part('month') + '-' + part('day');
}

function isNewMovementMessage(input) {
  if (/^(?:ignora|ignor[aá]|omit[ií]|inclu[ií]|fila\s*\d+|(?:el|la)\s+\d+\s+(?:va|es|pon|cambi))/i.test(input)) return false;
  if (/\b(?:pon[eé]|cambi[aá]|correg[ií]|va en)\b/i.test(input)) return false;
  return /(?:\$|\bARS\b|\bUSD\b)\s*\d|\b\d{2,}(?:[.,]\d+)*\b/i.test(input) || /^(?:nuevo\s+(?:gasto|ingreso|movimiento)|(?:tambi[eé]n\s+)?(?:cre[aá]|agreg[aá]|registr[aá]|carg[aá])\b)/i.test(input);
}

function isCorrectionMessage(input, pending) {
  if (!pending?.rows.length) return false;
  if (/^\s*(?:(?:fila|el|la)\s+)?\d{1,2}\s+[a-záéíóú]/i.test(input)) return true;
  return !isNewMovementMessage(input);
}

function preview(batch, categories) {
  const names = new Map(categories.map((item) => [item.id, item.name]));
  const lines = batch.rows.map((row, index) => {
    const mark = row.include ? '✅' : '⏸️';
    const value = Number.isFinite(row.amount) ? row.currency === 'USD' ? 'US$' + row.amount : formatAmount(row.amount) : 'importe ilegible';
    const category = names.get(row.categoryId) || 'Sin categoría';
    return `${mark} ${index + 1}. ${row.title} · ${value} · ${category}${row.include ? '' : ' (' + (row.reason || 'revisar') + ')'}`;
  });
  const ready = batch.rows.filter((row) => row.include).length;
  return ['**Propuesta de MisGastos**', ...(lines.length ? lines : ['No encontré movimientos legibles. Probá otra captura o escribilos en un mensaje.']), '',
    ready ? `Escribí **guardar** para cargar ${ready} movimiento${ready === 1 ? '' : 's'}. Podés corregir varias filas juntas: "1 Ropa y nombre Costurera, 2 Comida, ignorá 3".` : 'No hay movimientos listos para guardar. Podés corregir una o varias filas, o cancelar.'].join('\n').slice(0, 1900);
}

async function downloadImage(attachment) {
  const url = new URL(attachment.url);
  if (url.hostname !== 'cdn.discordapp.com' && url.hostname !== 'media.discordapp.net') throw new Error('Origen de imagen no permitido');
  if (attachment.size > 8_000_000) throw new Error('La captura supera 8 MB');
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw new Error('No se pudo descargar la captura');
  const mime = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('Mandá una imagen PNG, JPG o WebP');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8_000_000) throw new Error('La captura supera 8 MB');
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks), mime };
}

function createDiscordBot(store, config, onStatus = () => {}) {
  let client = null;
  let status = 'desconectado';
  let detail = '';
  let generation = 0;
  let processing = Promise.resolve();

  function info() { return config.publicSettings(status, detail); }
  function setStatus(next, message = '') {
    status = next;
    detail = String(message).slice(0, 150);
    try { onStatus(status, detail); } catch (_) { /* El diagnóstico no debe interrumpir Discord. */ }
  }

  async function processMessage(message, credentials) {
    if (message.author.bot || message.channelId !== credentials.channelId || !message.guild) return;
    if (store.hasSeenDiscordMessage(message.id)) return;
    const guild = message.guild.ownerId ? message.guild : await message.guild.fetch();
    if (message.author.id !== guild.ownerId) return;
    const attachments = [...message.attachments.values()].filter((item) => /^image\/(png|jpeg|webp)$/.test(item.contentType || '') || /\.(png|jpe?g|webp)$/i.test(item.name || '')).slice(0, 4);
    const input = message.content.trim();
    let pending = store.latestPendingBatch(message.channelId, message.author.id);

    try {
      if (pending && !pending.rows.length) {
        store.updateBatch(pending.id, pending.rows, 'cancelled');
        pending = null;
      }
      if (!pending && !attachments.length && /^(guardar|confirmar|listo|sí|si|cancelar|descartar|olvidar)$/i.test(input)) {
        await message.reply({ content: 'No hay una propuesta pendiente. Mandá una captura o un gasto primero.', allowedMentions: { parse: [] } });
      } else if (!attachments.length && /^(?:ayuda|a\s+q(?:u[eé])?\s+te\s+refer[ií]s|qu[eé]\s+quer[eé]s\s+decir)\??$/i.test(input)) {
        await message.reply({ content: 'Primero te muestro una propuesta; no guardo nada hasta que escribas **guardar**. Podés mandar una captura o un gasto como `Cuotas Mercado Pago $53.349 en Credito`. Para corregir varias filas, decime por ejemplo `1 Ropa y nombre Costurera, 2 Comida, ignorá 3`. Escribí **cancelar** para descartarla.', allowedMentions: { parse: [] } });
      } else if (!pending && !attachments.length && /^(record[aá]|aprend[eé]|acordate)/i.test(input)) {
        const categories = store.getState().data.categories;
        const edits = await interpretCorrections({ message: input, batch: { rows: [] }, categories });
        const result = applyCorrections({ message: input, rows: [], categories, edits });
        if (!result.rules.length) throw new Error('Decime el comercio y una categoría existente, por ejemplo: "recordá que Pepito Miguel va en Comida"');
        for (const rule of result.rules) store.setMerchantRule(rule.merchant, rule.categoryId);
        await message.reply({ content: result.rules.map((rule) => `Aprendí que ${rule.merchant} va en ${categories.find((item) => item.id === rule.categoryId).name}.`).join('\n').slice(0, 1900), allowedMentions: { parse: [] } });
      } else if (pending && !attachments.length && /^(guardar|confirmar|listo|sí|si)$/i.test(input)) {
        const count = store.commitBatch(pending.id);
        await message.reply({ content: count ? `Listo. Guardé ${count} movimiento${count === 1 ? '' : 's'} en MisGastos.` : 'No había movimientos listos para guardar.', allowedMentions: { parse: [] } });
      } else if (pending && !attachments.length && /^(cancelar|descartar|olvidar)$/i.test(input)) {
        store.updateBatch(pending.id, pending.rows, 'cancelled');
        await message.reply({ content: 'Descarté la propuesta. No cargué movimientos.', allowedMentions: { parse: [] } });
      } else if (!attachments.length && isCorrectionMessage(input, pending)) {
        const categories = store.getState().data.categories;
        const edits = await interpretCorrections({ message: input, batch: pending, categories });
        const result = applyCorrections({ message: input, rows: pending.rows, categories, edits });
        if (result.changed.length) store.updateBatch(pending.id, result.rows);
        for (const rule of result.rules) store.setMerchantRule(rule.merchant, rule.categoryId);
        const summary = result.changed.length ? `Actualicé ${result.changed.length === 1 ? 'la fila' : 'las filas'} ${result.changed.join(', ')}.\n` : '';
        const learned = result.rules.length ? '\nAprendí ' + result.rules.length + (result.rules.length === 1 ? ' categoría para próximas veces.' : ' categorías para próximas veces.') : '';
        await message.reply({ content: (summary + preview({ ...pending, rows: result.rows }, categories) + learned).slice(0, 1900), allowedMentions: { parse: [] } });
      } else if (attachments.length || isNewMovementMessage(input)) {
        const images = await Promise.all(attachments.map(downloadImage));
        const state = store.getState().data;
        const referenceRows = !images.length && /\b(?:el de|la fila|el\s+\d+|era el|ya est[aá] guardado|captura anterior)\b/i.test(input)
          ? store.latestUsefulBatch(message.channelId, message.author.id)?.rows || [] : [];
        const rows = await extractBatch({ images, caption: input, categories: state.categories, rules: store.merchantRules(), existing: state.transactions, today: todayInArgentina(), referenceRows });
        if (!rows.length) {
          await message.reply({ content: 'No encontré un movimiento concreto para proponer. Si hablás de una captura anterior, decime el comercio y el importe, por ejemplo: `Cuotas Mercado Pago $53.349 en Credito`. No guardé nada.', allowedMentions: { parse: [] } });
        } else {
          if (pending) store.updateBatch(pending.id, pending.rows, 'cancelled');
          const batch = store.saveBatch({ id: message.id, channelId: message.channelId, authorId: message.author.id, rows });
          await message.reply({ content: preview(batch, state.categories), allowedMentions: { parse: [] } });
        }
      } else if (input) {
        await message.reply({ content: 'No hay una propuesta para corregir. Mandá una captura o escribí un gasto con importe, por ejemplo: `Cuotas Mercado Pago $53.349 en Credito`. No guardé nada.', allowedMentions: { parse: [] } });
      } else return;
      store.markDiscordMessageSeen(message.id);
    } catch (error) {
      console.error('Discord processing error:', error);
      await message.reply({ content: 'No pude procesarlo: ' + String(error.message || 'error inesperado').slice(0, 180), allowedMentions: { parse: [] } }).catch(() => {});
      store.markDiscordMessageSeen(message.id);
    }
  }

  async function start() {
    const current = ++generation;
    if (client) { client.destroy(); client = null; }
    const credentials = config.credentials();
    if (!credentials.enabled) { setStatus('desconectado'); return; }
    if (!credentials.botToken || !credentials.channelId) { setStatus('error', 'Falta completar la configuración'); return; }
    const nextClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    client = nextClient;
    setStatus('conectando');
    nextClient.on(Events.MessageCreate, (message) => {
      processing = processing.then(() => processMessage(message, credentials)).catch((error) => console.error('Discord queue error:', error));
    });
    nextClient.on(Events.Error, (error) => { console.error('Discord connection error:', error); setStatus('error', error.message); });
    nextClient.once(Events.ClientReady, async () => {
      if (current !== generation) return;
      setStatus('conectado', nextClient.user.tag);
      try {
        const channel = await nextClient.channels.fetch(credentials.channelId);
        if (!channel?.isTextBased() || !channel.messages) throw new Error('El bot no puede leer el canal configurado');
        const recent = await channel.messages.fetch({ limit: 100 });
        for (const message of [...recent.values()].reverse()) {
          processing = processing.then(() => processMessage(message, credentials)).catch((error) => console.error('Discord history error:', error));
        }
      } catch (error) { setStatus('error', error.message); }
    });
    try { await nextClient.login(credentials.botToken); }
    catch (error) {
      if (current === generation) { setStatus('error', error.message); nextClient.destroy(); client = null; }
    }
  }

  function stop() { generation++; if (client) client.destroy(); client = null; setStatus('desconectado'); }
  return { start, stop, info };
}

module.exports = { createDiscordBot, preview, downloadImage, isNewMovementMessage, isCorrectionMessage };
