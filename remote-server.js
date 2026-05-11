const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const OLCRTC_BIN = '/opt/olcrtc/olcrtc-linux-amd64';
const OLCRTC_DIR = '/opt/olcrtc';

// База данных
const db = new Database('/opt/phantom/phantom.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    olcrtc_id TEXT NOT NULL,
    olcrtc_key TEXT NOT NULL,
    olcrtc_client_id TEXT NOT NULL,
    transport TEXT DEFAULT 'datachannel',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    traffic_limit INTEGER DEFAULT 0,
    expiration_date TEXT
  )
`);

const processes = new Map();

function startOlcrtc(client) {
  console.log(`[${client.name}] Запуск olcrtc...`);
  console.log(`[${client.name}] ID: ${client.olcrtc_id}`);
  console.log(`[${client.name}] Binary: ${OLCRTC_BIN}`);

  const args = [
    '-mode', 'srv',
    '-carrier', 'wbstream',
    '-transport', client.transport || 'datachannel',
    '-id', client.olcrtc_id,
    '-client-id', client.olcrtc_client_id,
    '-key', client.olcrtc_key,
    '-link', 'direct',
    '-dns', '1.1.1.1:53',
    '-data', `data_${client.id}`
  ];

  console.log(`[${client.name}] Args:`, args.join(' '));

  const proc = spawn(OLCRTC_BIN, args, {
    cwd: OLCRTC_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });

  proc.stdout.on('data', d => console.log(`[${client.name}]`, d.toString().trim()));
  proc.stderr.on('data', d => console.error(`[${client.name}] ERR:`, d.toString().trim()));
  proc.on('exit', (code) => {
    console.log(`[${client.name}] Процесс завершен с кодом ${code}`);
    processes.delete(client.id);
  });
  proc.on('error', err => {
    console.error(`[${client.name}] Ошибка запуска:`, err.message);
    console.error(`[${client.name}] Код ошибки:`, err.code);
  });

  processes.set(client.id, proc);
  return proc;
}

function stopOlcrtc(clientId) {
  const proc = processes.get(clientId);
  if (proc) {
    proc.kill('SIGTERM');
    processes.delete(clientId);
    console.log(`[${clientId}] Остановлен`);
  }
}

   // === МОНИТОРИНГ ===
    app.get('/api/stats', (req, res) => {
      exec('top -bn1 | grep "Cpu(s)"; free -m | grep "Mem:"; uptime; ps aux | grep olcrtc | grep -v grep | wc -l; df -h / | tail -1', (error, stdout) => {
        if (error) return res.status(500).json({ error: error.message });
        const parts = stdout.split('\n').map(l => l.trim()).filter(Boolean);
        
        // CPU: %Cpu(s):  1.5 us,  0.7 sy,  0.0 ni, 97.8 id...
        const cpuLine = parts.find(l => l.includes('Cpu(s)')) || '';
        const cpuMatch = cpuLine.match(/([0-9.]+)\s+id/);
        const cpuUsage = cpuMatch ? (100 - parseFloat(cpuMatch[1])).toFixed(1) + '%' : '1.2%';
    
        // RAM: Mem:   7945        2130        4012...
        const ramLine = parts.find(l => l.startsWith('Mem:')) || '';
        const ramParts = ramLine.split(/\s+/).filter(Boolean);
        const ramUsage = (ramParts[2] && ramParts[1]) ? ((parseInt(ramParts[2]) / parseInt(ramParts[1])) * 100).toFixed(1) + '%' : '15.4%';
    
        const diskLine = parts.find(l => l.includes('% /')) || parts[parts.length - 1] || '';
        const diskParts = diskLine.split(/\s+/).filter(Boolean);
        
        const uptimeLine = parts.find(l => l.includes('up')) || '';
    
        res.json({
          cpu: cpuUsage,
          ram: ramUsage,
          uptime: uptimeLine,
          olcrtcProcesses: parts.find(l => /^\d+$/.test(l)) || '0',
          disk: diskParts.length > 4 ? { 
            used: diskParts[2], 
            total: diskParts[1], 
            percent: diskParts[4] 
          } : { used: '0', total: '0', percent: '0%' }
        });
      });
    });

app.get('/api/logs', (req, res) => {
  exec('journalctl -u phantom -n 100 --no-pager', (error, stdout) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json({ logs: stdout });
  });
});

app.post('/api/cleanup', (req, res) => {
  exec('apt clean && apt autoremove -y && rm -rf /tmp/olcrtc && rm -rf ~/go && rm -rf /usr/local/go && journalctl --vacuum-size=100M', (error, stdout) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, output: stdout });
  });
});

// Создать клиента
app.post('/api/client/create', async (req, res) => {
  try {
    const { name, trafficLimit, expirationDate, transport, wbCallId } = req.body;
    
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!wbCallId) return res.status(400).json({ error: 'WB Call ID is required' });

    const id = crypto.randomUUID();
    const olcrtcId = wbCallId.trim(); // Используем реальный WB ID
    const olcrtcClientId = crypto.randomBytes(4).toString('hex');
    const olcrtcKey = crypto.randomBytes(32).toString('hex');

    db.prepare(`
      INSERT INTO clients (id, name, olcrtc_id, olcrtc_key, olcrtc_client_id, transport, traffic_limit, expiration_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, olcrtcId, olcrtcKey, olcrtcClientId, transport || 'datachannel', trafficLimit || 0, expirationDate || null);

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    startOlcrtc(client);

    res.json({ success: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Обновить WB ID клиента
app.patch('/api/client/:id/wb-id', (req, res) => {
  try {
    const { wbCallId } = req.body;
    if (!wbCallId) return res.status(400).json({ error: 'WB Call ID is required' });

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // Остановить старый процесс
    stopOlcrtc(req.params.id);

    // Обновить ID в БД
    db.prepare('UPDATE clients SET olcrtc_id = ? WHERE id = ?').run(wbCallId.trim(), req.params.id);

    // Запустить новый процесс
    const updatedClient = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
    startOlcrtc(updatedClient);

    res.json({ success: true, link: `olcrtc://wbstream?${updatedClient.transport}@${updatedClient.olcrtc_id}#${updatedClient.olcrtc_key}%${updatedClient.olcrtc_client_id}$OlcRTC` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Удалить клиента
app.delete('/api/client/:id', (req, res) => {
  try {
    stopOlcrtc(req.params.id);
    db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
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
    const transport = client.transport || 'datachannel';
    const link = `olcrtc://wbstream?${transport}@${client.olcrtc_id}#${client.olcrtc_key}%${client.olcrtc_client_id}$OlcRTC`;
    res.json({ link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Восстановить все процессы при старте
const allClients = db.prepare('SELECT * FROM clients').all();
console.log(`Восстанавливаю ${allClients.length} туннелей...`);
allClients.forEach(c => startOlcrtc(c));

// Запуск сервера
app.listen(3000, '0.0.0.0', () => {
  console.log('Remote Phantom Server running on port 3000');
});
