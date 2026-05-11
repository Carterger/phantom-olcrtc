import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { NodeSSH } from 'node-ssh';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  app.use(express.json());

  // === DEMO MODE ENDPOINTS ===
  const demoDb = new Database('demo.db');
  demoDb.exec(`
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

  const demoProcesses = new Set();

  app.post('/api/client/create', async (req, res) => {
    try {
      const { name, trafficLimit, expirationDate, transport, wbCallId } = req.body;
      if (!name) return res.status(400).json({ error: 'Name is required' });
      if (!wbCallId) return res.status(400).json({ error: 'Wildberries Call ID is required' });

      const id = crypto.randomUUID();
      
      const olcrtcId = wbCallId;

      const olcrtcClientId = crypto.randomBytes(4).toString('hex');
      const olcrtcKey = crypto.randomBytes(32).toString('hex');

      demoDb.prepare(`
        INSERT INTO clients (id, name, olcrtc_id, olcrtc_key, olcrtc_client_id, transport, traffic_limit, expiration_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, olcrtcId, olcrtcKey, olcrtcClientId, transport || 'datachannel', trafficLimit || 0, expirationDate || null);

      demoProcesses.add(id);

      res.json({ success: true, id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/client/:id', (req, res) => {
    try {
      const { wbCallId, transport, carrier } = req.body;
      const updates = [];
      const params = [];
      if (wbCallId) { updates.push('olcrtc_id = ?'); params.push(wbCallId); }
      if (transport) { updates.push('transport = ?'); params.push(transport); }
      if (carrier) { updates.push('carrier = ?'); params.push(carrier); }
      
      if (updates.length > 0) {
        params.push(req.params.id);
        demoDb.prepare(`UPDATE clients SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/client/:id', (req, res) => {
    try {
      demoProcesses.delete(req.params.id);
      demoDb.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/clients', (req, res) => {
    try {
      const clients = demoDb.prepare('SELECT * FROM clients ORDER BY created_at DESC').all() as any[];
      const result = clients.map(c => ({
        ...c,
        active: demoProcesses.has(c.id)
      }));
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/stats', (req, res) => {
    try {
      // Return demo stats or real ones if connected
      res.json({
        cpu: (Math.random() * 20 + 5).toFixed(1) + '%',
        ram: (Math.random() * 2 + 1).toFixed(1) + ' GB / 8 GB',
        uptime: '14d 6h 22m',
        net_up: (Math.random() * 100).toFixed(0) + ' Mbps',
        net_down: (Math.random() * 100).toFixed(0) + ' Mbps'
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/logs', (req, res) => {
    try {
      const logsArr = [
        `[${new Date().toISOString()}] INFO: Node starting...`,
        `[${new Date().toISOString()}] INFO: Connected to signaling server`,
        `[${new Date().toISOString()}] SUCCESS: Authenticated successfully`,
        `[${new Date().toISOString()}] INFO: Waiting for peers...`
      ];
      res.json({ logs: logsArr.join('\n') });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/client/:id/link', (req, res) => {
    try {
      const client = demoDb.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id) as any;
      if (!client) return res.status(404).json({ error: 'Not found' });
      const transport = client.transport || 'datachannel';
      const link = `olcrtc://wbstream?${transport}@${client.olcrtc_id}#${client.olcrtc_key}%${client.olcrtc_client_id}$OlcRTC`;
      res.json({ link });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // === SSH ENDPOINTS (ELECTRON-LIKE ORCHESTRATION) ===

  app.get('/api/wb/call-id', async (req, res) => {
    try {
      const response = await fetch('https://stream.wb.ru/room/create', { redirect: 'manual' });
      const location = response.headers.get('location');
      if (location && location.includes('/room/')) {
        const id = location.split('/room/')[1].split('?')[0].replace(/\/$/, "");
        res.json({ id });
      } else if (response.url && response.url.includes('/room/')) {
        const id = response.url.split('/room/')[1].split('?')[0].replace(/\/$/, "");
        res.json({ id });
      } else {
        res.json({ id: crypto.randomUUID() });
      }
    } catch (err: any) {
      res.json({ id: crypto.randomUUID() });
    }
  });

  app.post('/api/ssh/test', async (req, res) => {
    const { host, username } = req.body;
    const password = req.body.password?.trim();
    console.log(`SSH Test: password length=${password?.length || 0}, start=${password?.substring(0, 3) || ''}`);
    try {
      const ssh = new NodeSSH();
      await ssh.connect({ host, username, password, readyTimeout: 10000 });
      ssh.dispose();
      res.json({ success: true });
    } catch (err: any) {
      console.error('SSH Test Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/ssh/exec', async (req, res) => {
    const { host, username, command } = req.body;
    const password = req.body.password?.trim();
    console.log('Connecting with:', { host, username, passwordLength: password?.length, passwordFirst3: password?.substring(0,3) });
    try {
      const ssh = new NodeSSH();
      await ssh.connect({ host, username, password, readyTimeout: 30000 });
      const result = await ssh.execCommand(command, { 
        execOptions: { pty: true },
        onStdout: chunk => console.log(chunk.toString()),
        onStderr: chunk => console.error(chunk.toString())
      });
      ssh.dispose();
      
      if (result.code !== 0 && result.code !== null) {
        return res.status(400).json({ error: result.stderr || result.stdout || 'Command failed' });
      }
      res.json({ success: true, stdout: result.stdout, stderr: result.stderr });
    } catch (err: any) {
      console.error('SSH Error details:', JSON.stringify(err));
      res.status(500).json({ error: err.message, code: err.code, level: err.level });
    }
  });

  app.post('/api/ssh/upload', async (req, res) => {
    const { host, username, remotePath } = req.body;
    const password = req.body.password?.trim();
    try {
      const ssh = new NodeSSH();
      await ssh.connect({ host, username, password, readyTimeout: 15000 });
      
      const localPath = path.join(__dirname, 'remote-server.js');
      await ssh.putFile(localPath, remotePath);
      ssh.dispose();
      res.json({ success: true });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // === PROXY ENDPOINT FOR PREVIEW HTTPS WORKAROUND ===
  // Due to Mixed Content policies in the browser, calling HTTP directly from an HTTPS preview
  // will be blocked. We proxy requests through our local HTTPS server.
  app.post('/api/proxy', async (req, res) => {
    const { target, method = 'GET', body } = req.body;
    if (!target || !target.startsWith('http')) {
      return res.status(400).json({ error: 'Invalid proxy target' });
    }
    try {
      const response = await fetch(target, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return res.status(response.status).json(data);
      }
      res.json(data);
    } catch (err: any) {
      console.error('Proxy Error:', err.message);
      res.status(500).json({ error: 'Failed to connect to remote node: ' + err.message });
    }
  });

  // Vite integration
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  const PORT = 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Development API Proxy and Setup Orchestrator running on http://localhost:${PORT}`);
  });
}

startServer();
