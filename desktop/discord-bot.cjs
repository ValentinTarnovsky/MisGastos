const { Client, Events, GatewayIntentBits } = require('discord.js');
const { extractBatch, interpretCorrection } = require('./discord-ai.cjs');

function formatAmount(amount) { return '$' + Number(amount).toLocaleString('es-AR'); }

function todayInArgentina() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type) => parts.find((item) => item.type === type).value;
  return part('year') + '-' + part('month') + '-' + part('day');
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
    ready ? `Escribí **guardar** para cargar ${ready} movimiento${ready === 1 ? '' : 's'}. También podés decir "ignora el 2" o "el 3 va en Comida".` : 'No hay movimientos listos para guardar. Podés corregir una fila o cancelar.'].join('\n').slice(0, 1900);
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

function createDiscordBot(store, config) {
  let client = null;
  let status = 'desconectado';
  let detail = '';
  let generation = 0;
  let processing = Promise.resolve();

  function info() { return config.publicSettings(status, detail); }
  function setStatus(next, message = '') { status = next; detail = String(message).slice(0, 150); }

  async function processMessage(message, credentials) {
    if (message.author.bot || message.channelId !== credentials.channelId || !message.guild) return;
    if (store.hasSeenDiscordMessage(message.id)) return;
    const guild = message.guild.ownerId ? message.guild : await message.guild.fetch();
    if (message.author.id !== guild.ownerId) return;
    const attachments = [...message.attachments.values()].filter((item) => /^image\/(png|jpeg|webp)$/.test(item.contentType || '') || /\.(png|jpe?g|webp)$/i.test(item.name || '')).slice(0, 4);
    const input = message.content.trim();
    const pending = store.latestPendingBatch(message.channelId, message.author.id);

    try {
      if (!pending && !attachments.length && /^(guardar|confirmar|listo|sí|si|cancelar|descartar|olvidar)$/i.test(input)) {
        await message.reply({ content: 'No hay una propuesta pendiente. Mandá una captura o un gasto primero.', allowedMentions: { parse: [] } });
      } else if (!pending && !attachments.length && /^(record[aá]|aprend[eé]|acordate)/i.test(input)) {
        const categories = store.getState().data.categories;
        const correction = await interpretCorrection({ apiKey: credentials.apiKey, message: input, batch: { rows: [] }, categories });
        const category = categories.find((item) => item.id === correction.categoryId && item.kind === 'expense');
        const merchant = String(correction.merchant || '').trim();
        if (!category || !merchant) throw new Error('Decime el comercio y una categoría existente, por ejemplo: "recordá que Pepito Miguel va en Comida"');
        store.setMerchantRule(merchant, category.id);
        await message.reply({ content: `Aprendí que ${merchant} va en ${category.name}.`, allowedMentions: { parse: [] } });
      } else if (pending && !attachments.length && /^(guardar|confirmar|listo|sí|si)$/i.test(input)) {
        const count = store.commitBatch(pending.id);
        await message.reply({ content: count ? `Listo. Guardé ${count} movimiento${count === 1 ? '' : 's'} en MisGastos.` : 'No había movimientos listos para guardar.', allowedMentions: { parse: [] } });
      } else if (pending && !attachments.length && /^(cancelar|descartar|olvidar)$/i.test(input)) {
        store.updateBatch(pending.id, pending.rows, 'cancelled');
        await message.reply({ content: 'Descarté la propuesta. No cargué movimientos.', allowedMentions: { parse: [] } });
      } else if (pending && !attachments.length && !/^\s*(?:nuevo\s+)?(?:\$\s*)?\d[\d.,]*\s+/.test(input)) {
        const categories = store.getState().data.categories;
        const correction = await interpretCorrection({ apiKey: credentials.apiKey, message: input, batch: pending, categories });
        const index = correction.index - 1;
        const row = pending.rows[index];
        const category = categories.find((item) => item.id === correction.categoryId);
        if (correction.action === 'unknown' || (correction.action !== 'remember' && !row)) {
          await message.reply({ content: 'No pude identificar cuál fila cambiar. Decime el número, por ejemplo: "ignora el 2".', allowedMentions: { parse: [] } });
        } else if (correction.action === 'ignore') {
          row.include = false;
          row.reason = 'Ignorado por indicación tuya';
          store.updateBatch(pending.id, pending.rows);
          await message.reply({ content: preview(pending, categories), allowedMentions: { parse: [] } });
        } else if (correction.action === 'include') {
          if (row.currency !== 'ARS' || !categories.some((item) => item.id === row.categoryId && item.kind === row.kind)) throw new Error('Primero indicá una categoría válida en ARS para esa fila');
          row.include = true;
          row.reason = '';
          store.updateBatch(pending.id, pending.rows);
          await message.reply({ content: preview(pending, categories), allowedMentions: { parse: [] } });
        } else if (!category || (row && category.kind !== row.kind)) {
          await message.reply({ content: 'No encontré esa categoría para el tipo de movimiento. Decime una de tus categorías existentes.', allowedMentions: { parse: [] } });
        } else {
          const merchant = String(correction.merchant || row?.title || '').trim();
          const learn = correction.remember || correction.action === 'remember' || (correction.action === 'category' && row?.kind === 'expense' && !/solo esta vez/i.test(input));
          if (learn) {
            if (category.kind !== 'expense' || !merchant) throw new Error('La regla necesita un comercio y una categoría de gasto');
            store.setMerchantRule(merchant, category.id);
          }
          if (row) {
            row.categoryId = category.id;
            const heldForCard = /tarjeta|cuota|usd|d[oó]lar/i.test(row.reason || '') || row.currency !== 'ARS';
            row.include = !heldForCard;
            row.reason = row.include ? '' : (row.reason || 'Gasto para cargar por separado');
            store.updateBatch(pending.id, pending.rows);
            await message.reply({ content: preview(pending, categories) + (learn ? '\nAprendí esta categoría para las próximas veces.' : ''), allowedMentions: { parse: [] } });
          } else {
            await message.reply({ content: `Aprendí que ${merchant} va en ${category.name}.`, allowedMentions: { parse: [] } });
          }
        }
      } else if (attachments.length || input) {
        const images = await Promise.all(attachments.map(downloadImage));
        const state = store.getState().data;
        const rows = await extractBatch({ apiKey: credentials.apiKey, images, caption: input, categories: state.categories, rules: store.merchantRules(), existing: state.transactions, today: todayInArgentina() });
        if (pending) store.updateBatch(pending.id, pending.rows, 'cancelled');
        const batch = store.saveBatch({ id: message.id, channelId: message.channelId, authorId: message.author.id, rows });
        await message.reply({ content: preview(batch, state.categories), allowedMentions: { parse: [] } });
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
    if (!credentials.botToken || !credentials.apiKey || !credentials.channelId) { setStatus('error', 'Falta completar la configuración'); return; }
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

module.exports = { createDiscordBot, preview, downloadImage };
