'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Storage fallback in /tmp for Vercel Serverless
const TMP_FILE = path.join('/tmp', 'cc_rooms_state.json');

// In-memory memory store
let memoryRooms = {};

function loadStore(){
  try {
    if (fs.existsSync(TMP_FILE)) {
      const data = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
      memoryRooms = { ...memoryRooms, ...data };
    }
  } catch (e) {
    // Ignore /tmp read error
  }
}

function persistStore(){
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(memoryRooms), 'utf8');
  } catch (e) {
    // Ignore /tmp write error
  }
}

// Optional Vercel KV / Upstash Redis support if configured
async function getFromKv(roomKey){
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${encodeURIComponent(roomKey)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.result ? JSON.parse(json.result) : null;
  } catch (e) {
    return null;
  }
}

async function setToKv(roomKey, value){
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    await fetch(`${url}/set/${encodeURIComponent(roomKey)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(value)
    });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-room-id');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const room = (url.searchParams.get('room') || req.headers['x-room-id'] || 'borderland-protocol').trim().toLowerCase();
  const roomKey = `cc_room_${room}`;

  loadStore();

  if (req.method === 'GET') {
    // 1. Try KV if available
    let roomData = await getFromKv(roomKey);
    // 2. Fall back to memory / /tmp
    if (!roomData) {
      roomData = memoryRooms[room] || null;
    }
    return res.status(200).json({
      ok: true,
      room,
      state: roomData ? roomData.state : null,
      serverTime: Date.now(),
      lastUpdated: roomData ? roomData.timestamp : null
    });
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const newState = body.state;
    if (!newState) {
      return res.status(400).json({ error: 'Missing state object in payload' });
    }

    const payload = {
      state: newState,
      timestamp: Date.now()
    };

    memoryRooms[room] = payload;
    persistStore();
    await setToKv(roomKey, payload);

    return res.status(200).json({
      ok: true,
      room,
      timestamp: payload.timestamp
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
