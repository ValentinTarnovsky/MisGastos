const fs = require('node:fs');
const path = require('node:path');

function createDiscordConfig(userDataPath, safeStorage) {
  const configPath = path.join(userDataPath, 'discord-config.json');
  let saved = {};
  if (fs.existsSync(configPath)) {
    try { saved = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch { saved = {}; }
  }

  function secret(key) {
    if (!saved[key]) return '';
    try { return safeStorage.decryptString(Buffer.from(saved[key], 'base64')); }
    catch { return ''; }
  }

  function publicSettings(status = 'desconectado', detail = '') {
    return {
      enabled: saved.enabled === true,
      channelId: saved.channelId || '',
      hasBotToken: Boolean(secret('botToken')),
      hasApiKey: Boolean(secret('apiKey')),
      status,
      detail
    };
  }

  function credentials() {
    return { enabled: saved.enabled === true, channelId: saved.channelId || '', botToken: secret('botToken'), apiKey: secret('apiKey') };
  }

  function update(input) {
    if (!input || typeof input !== 'object') throw new Error('Configuración inválida');
    const channelId = String(input.channelId || '').trim();
    if (channelId && !/^\d{17,22}$/.test(channelId)) throw new Error('El ID del canal no es válido');
    if (typeof input.enabled !== 'boolean') throw new Error('Elegí si querés activar el bot');
    const botToken = String(input.botToken || '').trim();
    const apiKey = String(input.apiKey || '').trim();
    if (botToken.length > 300 || apiKey.length > 300) throw new Error('Credencial demasiado larga');
    if (input.enabled && (!channelId || !(botToken || secret('botToken')) || !(apiKey || secret('apiKey')))) {
      throw new Error('Faltan el canal o las claves para activar el bot');
    }
    if ((botToken || apiKey) && !safeStorage.isEncryptionAvailable()) throw new Error('Windows no puede proteger las claves en este momento');
    const next = { ...saved, enabled: input.enabled, channelId };
    if (botToken) next.botToken = safeStorage.encryptString(botToken).toString('base64');
    if (apiKey) next.apiKey = safeStorage.encryptString(apiKey).toString('base64');
    const temporary = configPath + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temporary, configPath);
    saved = next;
    return publicSettings();
  }

  return { credentials, publicSettings, update };
}

module.exports = { createDiscordConfig };
