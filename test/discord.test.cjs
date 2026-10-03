const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../desktop/store.cjs');
const { extractBatch } = require('../desktop/discord-ai.cjs');
const { createDiscordConfig } = require('../desktop/discord-config.cjs');

const initialStatePath = path.join(__dirname, '..', 'initial-state.json');

test('Discord batch stores only confirmed included movements and learns merchant rules', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'misgastos-discord-test-'));
  const store = await openStore(folder, initialStatePath);
  try {
    store.setMerchantRule('Pepito Miguel', 'food');
    assert.deepEqual(store.merchantRules(), [{ merchant: 'Pepito Miguel', categoryId: 'food' }]);
    const rows = [
      { title: 'Pepito Miguel', kind: 'expense', amount: 560, currency: 'ARS', date: '2026-10-03', time: '12:10', categoryId: 'food', include: true, reason: '' },
      { title: 'Cloudflare', kind: 'expense', amount: 5, currency: 'USD', date: '2026-10-03', time: '09:00', categoryId: null, include: false, reason: 'Tarjeta' }
    ];
    const id = '1555788208703414336';
    store.saveBatch({ id, channelId: '1555788208703414335', authorId: '1555788208703414334', rows });
    assert.equal(store.commitBatch(id), 1);
    assert.equal(store.getState().data.transactions.length, 1);
    assert.equal(store.getState().data.transactions[0].amount, 560);
    assert.throws(() => store.commitBatch(id), /ya no está pendiente/);
    const beforeRestore = store.getState();
    assert.throws(() => store.restoreState(beforeRestore.data, [{ merchant: 'Pepito', categoryId: 'missing' }]), /Regla inválida/);
    assert.equal(store.getState().revision, beforeRestore.revision);
    store.restoreState(beforeRestore.data, [{ merchant: 'Starbucks', categoryId: 'food' }]);
    assert.deepEqual(store.merchantRules(), [{ merchant: 'Starbucks', categoryId: 'food' }]);
    store.markDiscordMessageSeen(id);
    assert.equal(store.hasSeenDiscordMessage(id), true);
  } finally {
    store.close();
    const resolved = path.resolve(folder);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('Vision proposal rounds ARS, applies learned rules and pauses USD or uncertain income', async () => {
  const runStructured = async (_schema, prompt, images) => {
    assert.match(prompt, /ignora AUSA/);
    assert.deepEqual(images, []);
    return { rows: [
    { title: 'Pepito Miguel', kind: 'expense', amount: 1197.05, currency: 'ARS', date: '2026-10-01', time: '12:10', categoryId: null, include: false, reason: 'Persona sin categoría' },
    { title: 'AUSA', kind: 'expense', amount: 1436.13, currency: 'ARS', date: '2026-10-01', time: '09:08', categoryId: 'services', include: true, reason: null },
    { title: 'Cloudflare', kind: 'expense', amount: 5, currency: 'USD', date: '2026-10-01', time: '07:43', categoryId: 'services', include: true, reason: null },
    { title: 'Ingreso de dinero', kind: 'income', amount: 858330, currency: 'ARS', date: '2026-10-01', time: '12:38', categoryId: null, include: false, reason: 'Origen incierto' }
    ] };
  };
  const rows = await extractBatch({ images: [], caption: 'ignora AUSA', categories: [
      { id: 'food', name: 'Comida', kind: 'expense' }, { id: 'services', name: 'Servicios', kind: 'expense' }, { id: 'other-income', name: 'Ingresos', kind: 'income' }
    ], rules: [{ merchant: 'Pepito Miguel', categoryId: 'food' }], existing: [], today: '2026-10-03', runStructured });
  assert.equal(rows[0].amount, 1197);
  assert.equal(rows[0].categoryId, 'food');
  assert.equal(rows[0].include, true);
  assert.equal(rows[1].include, false);
  assert.equal(rows[2].include, false);
  assert.equal(rows[3].include, false);
});

test('Discord credentials are stored encrypted and never returned to the UI', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'misgastos-config-test-'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from('encrypted:' + value),
    decryptString: (value) => value.toString().replace(/^encrypted:/, '')
  };
  try {
    const config = createDiscordConfig(folder, safeStorage);
    const result = config.update({ enabled: true, channelId: '1555788208703414335', botToken: 'bot-secret' });
    config.update({ enabled: true, channelId: '1555788208703414335', botToken: '' });
    assert.equal(result.hasBotToken, true);
    assert.equal('hasApiKey' in result, false);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    const fresh = createDiscordConfig(folder, safeStorage);
    assert.equal(fresh.credentials().botToken, 'bot-secret');
    assert.equal('apiKey' in fresh.credentials(), false);
    assert.equal(fs.readFileSync(path.join(folder, 'discord-config.json'), 'utf8').includes('bot-secret'), false);
  } finally {
    const resolved = path.resolve(folder);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
