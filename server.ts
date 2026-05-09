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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      traffic_limit INTEGER DEFAULT 0,
      expiration_date TEXT
    )
  `);

  const demoProcesses = new Set();

  app.post('/api/client/create', async (req, res) => {
    try {
      const { name, trafficLimit, expirationDate } = req.body;
      if (!name) return res.status(400).json({ error: 'Name is required' });

      const id = crypto.randomUUID();
      
      const olcrtcId = crypto.randomUUID();

      const olcrtcClientId = crypto.randomBytes(4).toString('hex');
      const olcrtcKey = crypto.randomBytes(32).toString('hex');

      demoDb.prepare(`
        INSERT INTO clients (id, name, olcrtc_id, olcrtc_key, olcrtc_client_id, traffic_limit, expiration_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, olcrtcId, olcrtcKey, olcrtcClientId, trafficLimit || 0, expirationDate || null);

      demoProcesses.add(id);

      res.json({ success: true, id });
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

  app.get('/api/client/:id/link', (req, res) => {
    try {
      const client = demoDb.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id) as any;
      if (!client) return res.status(404).json({ error: 'Not found' });
      const link = `olcrtc://wbstream?vp8channel@${client.olcrtc_id}#${client.olcrtc_key}%${client.olcrtc_client_id}$OlcRTC`;
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

  app.post('/api/ssh/exec', async (req, res) => {
    const { host, username, password, command } = req.body;
    try {
      const ssh = new NodeSSH();
      await ssh.connect({ host, username, password, readyTimeout: 15000 });
      const result = await ssh.execCommand(command);
      ssh.dispose();
      
      if (result.code !== 0 && result.code !== null) {
        return res.status(400).json({ error: result.stderr || result.stdout || 'Command failed' });
      }
      res.json({ success: true, stdout: result.stdout, stderr: result.stderr });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/ssh/upload', async (req, res) => {
    const { host, username, password, remotePath } = req.body;
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
      res.status(500).json({ error: err.message });
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
