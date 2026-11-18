'use strict';
const fs = require('node:fs');
const path = require('node:path');

const TMP_FILE = path.join('/tmp', 'cc_submissions.json');
let submissionsStore = {}; // [room]: [ { id, timestamp, type, payload } ]

function loadStore(){
  try {
    if (fs.existsSync(TMP_FILE)) {
      const data = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
      submissionsStore = { ...submissionsStore, ...data };
    }
  } catch (e) {}
}

function persistStore(){
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(submissionsStore), 'utf8');
  } catch (e) {}
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-room-id');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const room = (url.searchParams.get('room') || req.headers['x-room-id'] || 'borderland-protocol').trim().toLowerCase();
  const since = Number(url.searchParams.get('since') || 0);

  loadStore();
  submissionsStore[room] = submissionsStore[room] || [];

  // GET: Host queries submissions
  if (req.method === 'GET') {
    const list = submissionsStore[room].filter(s => s.timestamp > since);
    // Cleanup old submissions older than 10 minutes
    const tenMinAgo = Date.now() - 600000;
    submissionsStore[room] = submissionsStore[room].filter(s => s.timestamp > tenMinAgo);
    persistStore();

    return res.status(200).json({
      ok: true,
      room,
      submissions: list,
      serverTime: Date.now()
    });
  }

  // POST: Participant submits an action
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const item = {
      id: Math.random().toString(36).slice(2) + Date.now().toString(36),
      timestamp: Date.now(),
      type: body.type || 'generic',
      submission: body.submission || body
    };

    submissionsStore[room].push(item);
    if (submissionsStore[room].length > 500) {
      submissionsStore[room] = submissionsStore[room].slice(-300);
    }
    persistStore();

    return res.status(200).json({
      ok: true,
      id: item.id,
      timestamp: item.timestamp
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
