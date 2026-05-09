const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const { spawn } = require('child_process');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const OLCRTC_BIN = '/opt/olcrtc/olcrtc-linux-amd64';
const OLCRTC_DIR = '/opt/olcrtc';

// Инициализация БД
const db = new Database('/opt/phantom/phantom.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    olcrtc_id TEXT NOT NULL,
    olcrtc_key TEXT NOT NULL,
    olcrtc_client_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    traffic_limit INTEGER DEFAULT 0,
    expiration_date TEXT
  )
`);

const processes = new Map();

function startOlcrtc(client) {
  console.log(`[${client.name}] Открытие olcrtc...`);
  const proc = spawn(OLCRTC_BIN, [
    '-mode', 'srv',
    '-carrier', 'wbstream',
    '-transport', 'vp8channel',
    '-id', client.olcrtc_id,
    '-client-id', client.olcrtc_client_id,
    '-key', client.olcrtc_key,
    '-link', 'direct',
    '-dns', '1.1.1.1:53',
    '-data', `data_${client.id}`,
    '-vp8-fps', '60',
    '-vp8-batch', '64'
  ], {
    cwd: OLCRTC_DIR,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.stdout.on('data', d => console.log(`[${client.name}]`, d.toString().trim()));
  proc.stderr.on('data', d => console.error(`[${client.name}] ERR:`, d.toString().trim()));
  proc.on('exit', () => {
    console.log(`[${client.name}] Процесс завершен`);
    processes.delete(client.id);
  });
  proc.on('error', err => console.error(`[${client.name}] Ошибка:`, err.message));

  processes.set(client.id, proc);
}

function stopOlcrtc(clientId) {
  const proc = processes.get(clientId);
  if (proc) {
    proc.kill('SIGTERM');
    processes.delete(clientId);
    console.log(`[${clientId}] Остановлен`);
  }
}

app.post('/api/client/create', async (req, res) => {
  try {
    const { name, trafficLimit, expirationDate } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const id = crypto.randomUUID();
    
    const olcrtcId = crypto.randomUUID();

    const olcrtcClientId = crypto.randomBytes(4).toString('hex');
    const olcrtcKey = crypto.randomBytes(32).toString('hex');

    db.prepare(`
      INSERT INTO clients (id, name, olcrtc_id, olcrtc_key, olcrtc_client_id, traffic_limit, expiration_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, olcrtcId, olcrtcKey, olcrtcClientId, trafficLimit || 0, expirationDate || null);

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    startOlcrtc(client);

    res.json({ success: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Удаление клиента
app.delete('/api/client/:id', (req, res) => {
  try {
    stopOlcrtc(req.params.id);
    db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Список клиентов
app.get('/api/clients', (req, res) => {
  try {
    const clients = db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all();
    const result = clients.map(c => ({
      ...c,
      active: processes.has(c.id)
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получить ссылку
app.get('/api/client/:id/link', (req, res) => {
  try {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
    if (!client) return res.status(404).json({ error: 'Not found' });
    const link = `olcrtc://wbstream?vp8channel@${client.olcrtc_id}#${client.olcrtc_key}%${client.olcrtc_client_id}$OlcRTC`;
    res.json({ link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Автозапуск
const allClients = db.prepare('SELECT * FROM clients').all();
allClients.forEach(c => startOlcrtc(c));

// Запуск
app.listen(3000, '0.0.0.0', () => {
  console.log('Remote Phantom Server running on port 3000');
});
