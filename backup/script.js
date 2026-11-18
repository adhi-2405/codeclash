/* CODE CLASH — BORDERLAND PROTOCOL (ONLINE + BACKUP ENGINE)
 * Client-Serverless Hybrid Architecture: HTML5 + CSS + Vanilla JavaScript
 * Vercel-ready: Runs online across all devices with real-time room sync.
 * Zero database required: Ephemeral cloud sync with local persistent fallback.
 */
'use strict';

const QUESTIONS_DATA = window.QUESTIONS_DATA || { r1: [], cases: {} };
const r1 = QUESTIONS_DATA.r1 || [];
const cases = QUESTIONS_DATA.cases || {};
const SLOT = 20; // Round 1 question slot in seconds
const R2_SLOT_MS = 300_000; // 5 minutes per Round 2 question
const R2_TOTAL_MS = 1_200_000; // 20 minutes total for Round 2
const ADMIN_PASSWORD_DEFAULT = 'AdminPass123!';
const STORAGE_KEY = 'CODE_CLASH_ONLINE_STATE';
const SESSION_KEY = 'cc_session';
const ADMIN_KEY = 'cc_admin';

// --- ONLINE ROOM & CLOUD SYNC CONFIG ---
const urlParams = (typeof window !== 'undefined' && window.location && typeof URLSearchParams !== 'undefined')
  ? new URLSearchParams(window.location.search)
  : { get: () => null };
let currentRoom = (urlParams.get('room') || (typeof localStorage !== 'undefined' && localStorage.getItem('cc_room_id')) || 'borderland-protocol').trim().toLowerCase();
const isOnlineMode = typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http');
let lastSubmissionsPoll = 0;
let lastSyncPush = 0;
let lastSyncReceived = 0;

// --- CORE LOGIC HELPERS ---
function norm(s){
  return String(s ?? '').trim().toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').replace(/[.,!?;:]+$/g, '');
}

function validLogin({name, registerno, department, consent}){
  return !!consent && typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 60 &&
    /^[\p{L} .]+$/u.test(name.trim()) && typeof registerno === 'string' && /^\d{6,15}$/.test(registerno) &&
    typeof department === 'string' && /^[a-zA-Z0-9]{2,12}$/.test(department.trim());
}

function r1Score(p){
  return Math.max(0, Object.values(p.r1Answers || {}).reduce((n, a) => n + (a.correct ? a.points : 0), 0) + (p.r1Correction || 0));
}

function r2Score(p){
  return Math.max(0, Object.values(p.r2Answers || {}).reduce((n, a) => n + (a.correct ? Math.max(0, a.points - (a.hintUsed ? 1 : 0)) : 0), 0) + (p.r2Correction || 0));
}

function r2Time(p){
  const good = Object.values(p.r2Answers || {}).filter(a => a.correct);
  return { time: good.length ? Math.max(...good.map(a => Number(a.answeredAt) || 0)) : Infinity, count: good.length };
}

function r1Slot(startAt, currentAt, slotSeconds = 20, pausedMs = 0){
  if (!startAt) return 0;
  return Math.min(30, Math.max(0, Math.floor((currentAt - startAt - pausedMs) / 1000 / slotSeconds) + 1));
}

function qualifyPlayers(players, limit = 12){
  const eligible = players.filter(p => !p.r1PendingReview && !p.r1Disqualified);
  const sorted = [...eligible].sort((a, b) => b.r1 - a.r1);
  const cutoff = sorted[Math.min(Math.max(1, limit), sorted.length) - 1]?.r1 ?? -1;
  return sorted.filter(p => cutoff >= 0 && p.r1 >= cutoff);
}

function gradeR2(question, answer, hintUsed = false, extraAccepted = []){
  const correct = [...question.accepted, ...extraAccepted].includes(norm(answer));
  return { correct, score: correct ? Math.max(0, question.points - (hintUsed ? 1 : 0)) : 0 };
}

function rankPlayers(list){
  const original = new Map(list.map((p, i) => [p, i]));
  list.sort((a, b) => b.total - a.total);
  for (let start = 0; start < list.length;){
    let end = start + 1;
    while (end < list.length && list[end].total === list[start].total) end++;
    const group = list.slice(start, end).sort((a, b) => {
      if ((a.r2 ?? 0) !== (b.r2 ?? 0)) return (b.r2 ?? 0) - (a.r2 ?? 0);
      const ta = r2Time(a), tb = r2Time(b);
      if (!ta.count && tb.count) return 1;
      if (ta.count && !tb.count) return -1;
      if (ta.count && tb.count && ta.time !== tb.time) return ta.time - tb.time;
      return original.get(a) - original.get(b);
    });
    list.splice(start, end - start, ...group);
    start = end;
  }
  return list;
}

function mask(reg){
  return '*'.repeat(Math.max(0, (reg || '').length - 4)) + (reg || '').slice(-4);
}

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shuffled(a){
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

function randomToken(){
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// --- STATE MANAGEMENT ---
function blankState(){
  return {
    version: 1,
    createdAt: Date.now(),
    room: currentRoom,
    event: {
      status: 'upcoming',
      r1StartedAt: null,
      r1EndsAt: null,
      r2StartedAt: null,
      r2EndsAt: null,
      pauseAt: null,
      pausedMs: 0,
      finalistsLimit: 12,
      winnersPublished: false,
      loginOpen: true,
      leaderboardVisible: false
    },
    players: {},
    sessions: {},
    roster: null,
    assignments: {},
    audit: [],
    suddenDeath: null,
    acceptedAdditions: {},
    adminToken: null
  };
}

let state = null;
function loadState(){
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}_${currentRoom}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = { ...blankState(), ...parsed };
      state.event = { ...blankState().event, ...(parsed.event || {}) };
      state.players = state.players || {};
      state.sessions = state.sessions || {};
      state.assignments = state.assignments || {};
      state.audit = state.audit || [];
      state.acceptedAdditions = state.acceptedAdditions || {};
      return;
    }
  } catch (e) {
    console.warn('Could not parse local state, starting fresh:', e);
  }
  state = blankState();
  saveState(false, false);
}

const syncChannel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel(`cc_sync_${currentRoom}`) : null;
const eventListeners = new Set();

function emitSync(type = 'state'){
  if (syncChannel) {
    try { syncChannel.postMessage({ type, timestamp: Date.now() }); } catch(e){}
  }
  for (const fn of eventListeners) {
    try { fn({ type, serverNow: Date.now(), event: state.event }); } catch(e){}
  }
}

function saveState(notify = true, pushCloud = true){
  try {
    localStorage.setItem(`${STORAGE_KEY}_${currentRoom}`, JSON.stringify(state));
  } catch(e) {
    console.error('Storage quota exceeded or error:', e);
  }
  if (notify) emitSync('state');
  if (pushCloud && isOnlineMode && sessionStorage.getItem(ADMIN_KEY)) {
    pushStateToCloud();
  }
}

window.addEventListener('storage', (e) => {
  if (e.key === `${STORAGE_KEY}_${currentRoom}`) {
    loadState();
    triggerViewRefresh();
  }
});

if (syncChannel) {
  syncChannel.onmessage = () => {
    loadState();
    triggerViewRefresh();
  };
}

// --- CLOUD SYNC ENGINE FOR ONLINE MULTI-DEVICE SUPPORT ---
async function pushStateToCloud(force = false){
  if (!isOnlineMode) return;
  const now = Date.now();
  if (!force && now - lastSyncPush < 600) return;
  lastSyncPush = now;
  try {
    const snapshot = { ...state };
    delete snapshot.adminToken;
    await fetch(`/api/sync?room=${encodeURIComponent(currentRoom)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-room-id': currentRoom },
      body: JSON.stringify({ state: snapshot, room: currentRoom })
    });
    const net = el('netStatus');
    if (net) { net.textContent = '● ONLINE'; net.style.color = 'var(--cyan)'; }
  } catch (e) {
    const net = el('netStatus');
    if (net) { net.textContent = '○ CONNECTING'; net.style.color = 'var(--amber)'; }
  }
}

async function pullStateFromCloud(){
  if (!isOnlineMode) return;
  try {
    const res = await fetch(`/api/sync?room=${encodeURIComponent(currentRoom)}`, {
      headers: { 'x-room-id': currentRoom, 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) return;
    const json = await res.json();
    if (json.state && json.lastUpdated && json.lastUpdated > lastSyncReceived) {
      lastSyncReceived = json.lastUpdated;
      const wasAdmin = !!sessionStorage.getItem(ADMIN_KEY);
      state = { ...blankState(), ...json.state };
      if (wasAdmin) state.adminToken = sessionStorage.getItem(ADMIN_KEY);
      saveState(true, false);
      triggerViewRefresh();
    }
    const net = el('netStatus');
    if (net) { net.textContent = '● ONLINE'; net.style.color = 'var(--cyan)'; }
  } catch (e) {
    const net = el('netStatus');
    if (net) { net.textContent = '○ CONNECTING'; net.style.color = 'var(--amber)'; }
  }
}

async function sendSubmissionToCloud(type, data){
  if (!isOnlineMode) return;
  try {
    await fetch(`/api/submit?room=${encodeURIComponent(currentRoom)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-room-id': currentRoom },
      body: JSON.stringify({ type, submission: data })
    });
  } catch (e) {}
}

async function pollSubmissionsAsHost(){
  if (!isOnlineMode || !sessionStorage.getItem(ADMIN_KEY)) return;
  try {
    const res = await fetch(`/api/submit?room=${encodeURIComponent(currentRoom)}&since=${lastSubmissionsPoll}`, {
      headers: { 'x-room-id': currentRoom }
    });
    if (!res.ok) return;
    const json = await res.json();
    if (json.submissions && json.submissions.length > 0) {
      let changed = false;
      for (const item of json.submissions) {
        lastSubmissionsPoll = Math.max(lastSubmissionsPoll, item.timestamp);
        const sub = item.submission;
        if (!sub) continue;

        if (item.type === 'login' && sub.registerno) {
          let p = state.players[sub.registerno];
          if (!p) {
            p = state.players[sub.registerno] = {
              registerno: sub.registerno,
              name: sub.name,
              department: sub.department,
              createdAt: item.timestamp,
              active: true,
              consentAt: item.timestamp,
              r1Answers: {},
              r1Drafts: {},
              r2Answers: {},
              r2Drafts: {}
            };
            if (state.event.status === 'r1') initPlayerR1(p);
            changed = true;
          } else {
            p.active = true;
            changed = true;
          }
        } else if (item.type === 'r1-submit' && sub.registerno) {
          const p = state.players[sub.registerno];
          if (p && !p.r1LockedOut) {
            recordR1(p, sub.optionId, sub.timedOut, sub.submissionTime || item.timestamp);
            changed = true;
          }
        } else if (item.type === 'r1-draft' && sub.registerno) {
          const p = state.players[sub.registerno];
          if (p && sub.qid && sub.optionId) {
            p.r1Drafts = p.r1Drafts || {};
            p.r1Drafts[sub.qid] = sub.optionId;
            changed = true;
          }
        } else if (item.type === 'r2-submit' && sub.registerno) {
          const p = state.players[sub.registerno];
          if (p && p.finalist) {
            recordR2(p, sub.number - 1, sub.answer, sub.timedOut);
            changed = true;
          }
        } else if (item.type === 'r2-draft' && sub.registerno) {
          const p = state.players[sub.registerno];
          if (p && p.finalist) {
            p.r2Drafts = p.r2Drafts || {};
            p.r2Drafts[sub.number - 1] = sub.answer;
            changed = true;
          }
        } else if (item.type === 'r2-hint' && sub.registerno) {
          const p = state.players[sub.registerno];
          if (p && p.finalist) {
            p.r2HintRevealed = p.r2HintRevealed || {};
            p.r2HintRevealed[sub.number - 1] = true;
            changed = true;
          }
        } else if (item.type === 'violation' && sub.registerno) {
          const p = state.players[sub.registerno];
          if (p) {
            p.r1Violations = p.r1Violations || [];
            p.r1Violations.push({ type: sub.type, round: sub.round, timestamp: item.timestamp });
            if (p.r1Violations.length >= 2) {
              p.r1PendingReview = true;
              if (sub.round === 'Round 1') {
                ensureR1Current(p);
                p.r1LockedOut = true;
              }
            }
            changed = true;
          }
        } else if (item.type === 'logout' && sub.registerno) {
          const p = state.players[sub.registerno];
          if (p) {
            p.active = false;
            changed = true;
          }
        }
      }
      if (changed) {
        saveState(true, true);
        triggerViewRefresh();
      }
    }
  } catch (e) {}
}

// Background sync loop
const syncLoopTimer = setInterval(() => {
  if (sessionStorage.getItem(ADMIN_KEY)) {
    pollSubmissionsAsHost();
  } else {
    pullStateFromCloud();
  }
}, 1200);
if (typeof syncLoopTimer.unref === 'function') syncLoopTimer.unref();

function audit(action, admin, record, oldValue, newValue, reason){
  state.audit.push({ action, admin: admin || 'system', record, oldValue, newValue, reason: String(reason || ''), timestamp: Date.now() });
  saveState();
}

function initPlayerR1(p){
  if (!p.r1Order) {
    const qs = shuffled(r1);
    p.r1Order = qs.map(q => q.id);
    p.r1Options = {};
    for (const q of qs) {
      const opts = shuffled(q.options);
      p.r1Options[q.id] = opts.map(label => ({
        id: Math.random().toString(36).slice(2, 10),
        label
      }));
    }
  }
  p.r1Options = p.r1Options || {};
  p.r1Answers = p.r1Answers || {};
  p.r1Drafts = p.r1Drafts || {};
  p.r1Violations = p.r1Violations || [];
  p.r1QuestionOpenedAt = p.r1QuestionOpenedAt || state.event.r1StartedAt;
  p.r1LockedOut = !!p.r1LockedOut;
  p.r1PendingReview = !!p.r1PendingReview;
}

function r1Index(p){
  return Object.keys(p.r1Answers || {}).length;
}

function recordR1(p, optionId = null, timedOut = false, forcedAt = null){
  const n = r1Index(p);
  if (n >= 30 || p.r1LockedOut) return;
  const qid = p.r1Order[n];
  const q = r1.find(x => x.id === qid);
  const opt = (p.r1Options[qid] || []).find(x => x.id === optionId);
  const opened = p.r1QuestionOpenedAt || state.event.r1StartedAt;
  const deadline = opened + SLOT * 1000;
  const at = forcedAt || (timedOut ? deadline : Date.now());
  const label = opt?.label || '';
  p.r1Answers[qid] = {
    optionId: opt?.id || null,
    answer: label,
    correct: !!opt && label === q.answer,
    points: q.points,
    openedAt: opened,
    answeredAt: at,
    submissionTime: at,
    timeTaken: Math.max(0, Math.floor((at - opened) / 1000)),
    timedOut: !!timedOut
  };
  delete p.r1Drafts[qid];
  p.r1QuestionOpenedAt = at;
  saveState();
}

function ensureR1Current(p){
  let guard = 0;
  while (!p.r1LockedOut && r1Index(p) < 30 && guard++ < 30) {
    const opened = p.r1QuestionOpenedAt || state.event.r1StartedAt;
    if (Date.now() < opened + SLOT * 1000) break;
    const n = r1Index(p), qid = p.r1Order[n], draft = p.r1Drafts?.[qid] || null;
    recordR1(p, draft, true, opened + SLOT * 1000);
  }
}

function r1QuestionFor(p){
  if (!state.event.r1StartedAt || Date.now() < state.event.r1StartedAt) return { waiting: true, deadline: state.event.r1StartedAt };
  if (p.r1LockedOut || p.r1Done) return null;
  ensureR1Current(p);
  const n = r1Index(p);
  if (n >= 30) return null;
  const qid = p.r1Order[n], q = r1.find(x => x.id === qid), opened = p.r1QuestionOpenedAt || state.event.r1StartedAt;
  return {
    id: q.id,
    number: n + 1,
    difficulty: q.difficulty,
    topic: q.topic,
    question: q.question,
    options: p.r1Options[qid],
    selectedOptionId: p.r1Drafts?.[qid] || null,
    deadline: opened + SLOT * 1000,
    openedAt: opened
  };
}

function r2Current(p){
  if (!p.finalist || !p.caseId || !state.event.r2StartedAt || Date.now() < state.event.r2StartedAt || p.r2Done) return null;
  const n = Object.keys(p.r2Answers || {}).length;
  if (n >= 4) return null;
  const q = cases[p.caseId].questions[n];
  const opened = p.r2OpenedAt || state.event.r2StartedAt;
  const deadline = Math.min(opened + R2_SLOT_MS, state.event.r2EndsAt || state.event.r2StartedAt + R2_TOTAL_MS);
  return {
    number: n + 1,
    question: q.q,
    points: q.points,
    openedAt: opened,
    deadline,
    hintRevealed: !!p.r2HintRevealed?.[n],
    draft: p.r2Drafts?.[n] || ''
  };
}

function ensureR2Deadline(p){
  const cur = r2Current(p);
  if (!cur) return;
  if (Date.now() >= cur.deadline) {
    const n = Object.keys(p.r2Answers || {}).length;
    const answer = p.r2Drafts?.[n] || '';
    recordR2(p, n, answer, true);
  }
}

function recordR2(p, n, answer, timedOut = false){
  if (p.r2Answers[n]) return;
  const q = cases[p.caseId].questions[n];
  const opened = p.r2OpenedAt || state.event.r2StartedAt;
  const at = timedOut ? Math.min(opened + R2_SLOT_MS, state.event.r2EndsAt || state.event.r2StartedAt + R2_TOTAL_MS) : Date.now();
  const hintUsed = !!p.r2HintRevealed?.[n];
  const extra = state.acceptedAdditions?.[`${p.caseId}:${n}`] || [];
  const graded = gradeR2(q, answer, hintUsed, extra);
  const correct = graded.correct;
  p.r2Answers[n] = {
    number: n + 1,
    answer: String(answer || '').slice(0, 200),
    correct,
    points: q.points,
    hintUsed,
    openedAt: opened,
    answeredAt: at,
    timeTaken: timedOut ? Math.floor((at - opened) / 1000) : Math.max(0, Math.floor((at - opened) / 1000)),
    timedOut
  };
  p.r2OpenedAt = at;
  p.r2Done = Object.keys(p.r2Answers).length >= 4 || at >= (state.event.r2EndsAt || state.event.r2StartedAt + R2_TOTAL_MS);
  saveState();
}

function standings(){
  const rows = rankPlayers(Object.values(state.players).map(p => ({
    ...p,
    r1: r1Score(p),
    r2: r2Score(p),
    total: r1Score(p) + r2Score(p),
    r2time: r2Time(p).time
  })));
  if (state.suddenDeath?.winnerRegisterno) {
    const winner = rows.findIndex(p => p.registerno === state.suddenDeath.winnerRegisterno);
    if (winner > 0) {
      const w = rows[winner];
      let start = winner;
      while (start > 0 && rows[start - 1].total === w.total && rows[start - 1].r2 === w.r2 &&
        ((!Number.isFinite(rows[start - 1].r2time) && !Number.isFinite(w.r2time)) || rows[start - 1].r2time === w.r2time)) start--;
      if (start < winner) {
        rows.splice(winner, 1);
        rows.splice(start, 0, w);
      }
    }
  }
  return rows;
}

function publicState(p){
  const ev = state.event;
  const out = {
    serverNow: Date.now(),
    room: currentRoom,
    event: { ...ev },
    participants: Object.keys(state.players).length,
    loggedIn: Object.values(state.players).filter(x => x.active).length
  };
  if (!p) return out;
  Object.assign(out, {
    name: p.name,
    department: p.department,
    maskedRegister: mask(p.registerno),
    active: p.active,
    finalist: !!p.finalist,
    caseId: p.finalist ? p.caseId : null,
    r1LockedOut: !!p.r1LockedOut,
    r1PendingReview: !!p.r1PendingReview
  });
  if (ev.status === 'r1' && !p.r1LockedOut && !ev.pauseAt) out.r1 = r1QuestionFor(p);
  if (['r1-ended', 'qualified', 'r2', 'r2-ended', 'completed'].includes(ev.status)) out.r1FinalScore = r1Score(p);
  if (p.finalist) {
    out.r2Info = {
      starting: ev.status === 'r2' && Date.now() < ev.r2StartedAt,
      startDeadline: ev.r2StartedAt,
      howItWorks: [
        'You get one case, assigned at random. Other finalists may have a different one.',
        'Each case has 4 questions, one at a time. You cannot go back.',
        'Each question has up to 5 minutes, but you can submit early to open the next question immediately.',
        'If you do not submit, the question locks at 5 minutes and your typed answer is sent automatically.',
        'Answers are short text: usually a word, time, address or short phrase. Write just the answer, not a paragraph.',
        'Points are 4, 4, 6 and 6, for 20 total. A wrong or blank answer scores 0.',
        'Each question has one optional hint. A correct answer after a hint loses 1 point; the hint cannot be undone.',
        'Speed never adds points; it is only used to separate players tied on total score.',
        'The evidence stays on screen for the whole case. Some details are red herrings.',
        'Monitoring is active in both rounds. Tab visibility, window focus and fullscreen-exit events are timestamped for admin review.'
      ],
      case: cases[p.caseId] ? {
        title: cases[p.caseId].title,
        description: cases[p.caseId].description,
        guide: cases[p.caseId].guide || '',
        exhibits: cases[p.caseId].exhibits
      } : null,
      question: r2Current(p),
      answers: Object.values(p.r2Answers || {}).map(a => ({ number: a.number, submitted: true }))
    };
  }
  return out;
}

function getSessionPlayer(){
  const tok = localStorage.getItem(SESSION_KEY);
  if (!tok) return null;
  const reg = Object.keys(state.sessions).find(k => state.sessions[k].token === tok);
  if (!reg) return null;
  const p = state.players[reg];
  return p && p.active ? p : null;
}

// Background sweep for auto-advancing expired questions
const sweeperTimer = setInterval(() => {
  if (!state) return;
  const now = Date.now();
  if (state.event.status === 'r2' && !state.event.pauseAt) {
    for (const p of Object.values(state.players)) {
      if (p.finalist) ensureR2Deadline(p);
    }
    if (now >= (state.event.r2EndsAt || state.event.r2StartedAt + R2_TOTAL_MS)) {
      for (const p of Object.values(state.players)) {
        if (p.finalist && !p.r2Done) {
          while (Object.keys(p.r2Answers).length < 4) {
            recordR2(p, Object.keys(p.r2Answers).length, p.r2Drafts[Object.keys(p.r2Answers).length] || '', true);
          }
          p.r2Done = true;
        }
      }
      state.event.status = 'r2-ended';
      saveState();
    }
  }
  if (state.event.status === 'r1' && !state.event.pauseAt) {
    let changed = false;
    for (const p of Object.values(state.players)) {
      if (!p.r1Order || p.r1LockedOut || p.r1Done) continue;
      const before = r1Index(p);
      ensureR1Current(p);
      if (r1Index(p) !== before) changed = true;
      if (r1Index(p) >= 30) p.r1Done = true;
    }
    if (changed) saveState();
    if (now >= (state.event.r1EndsAt || state.event.r1StartedAt + 30 * SLOT * 1000)) {
      Object.values(state.players).forEach(p => {
        ensureR1Current(p);
        p.r1Done = true;
      });
      state.event.status = 'r1-ended';
      state.event.r1EndsAt = now;
      saveState();
    }
  }
}, 250);
if (typeof sweeperTimer.unref === 'function') sweeperTimer.unref();

// --- CLIENT-SIDE REST/API SIMULATOR ---
async function api(endpoint, options = {}){
  loadState();
  const body = options.body ? JSON.parse(options.body) : {};
  const path = endpoint.replace(/^\/api/, '');
  const now = Date.now();

  function requireAdminAuth(){
    const tok = sessionStorage.getItem(ADMIN_KEY);
    if (!tok || !state.adminToken || tok !== state.adminToken) {
      throw new Error('Admin login required.');
    }
  }

  // Participant State
  if (path === '/state') return publicState(getSessionPlayer());

  // Participant Login
  if (path === '/login') {
    if (!validLogin(body)) throw new Error('Check your name, register number, department and consent.');
    if (state.event.status !== 'upcoming' || !state.event.loginOpen) throw new Error('Login is closed because the host has closed registration or Round 1 has started.');
    const reg = body.registerno, name = body.name.trim(), dept = body.department.trim().toUpperCase();
    if (state.roster) {
      const entry = state.roster[reg];
      if (!entry) throw new Error('This register number is not on the event roster.');
      if (entry.name.toLowerCase() !== name.toLowerCase() || entry.department !== dept) throw new Error('Name and department must match the event roster.');
    }
    let p = state.players[reg];
    if (p) {
      if (p.name.toLowerCase() !== name.toLowerCase() || p.department !== dept) throw new Error('Name and department must match the details first registered for this number.');
      if (p.active && !p.recoveryEnabled) throw new Error('This register number already has an active session.');
      if (p.active && p.recoveryEnabled) {
        delete state.sessions[reg];
        p.recoveryEnabled = false;
      }
    } else {
      p = state.players[reg] = {
        registerno: reg,
        name,
        department: dept,
        createdAt: now,
        active: true,
        consentAt: now,
        r1Answers: {},
        r1Drafts: {},
        r2Answers: {},
        r2Drafts: {}
      };
    }
    p.active = true;
    const t = randomToken();
    state.sessions[reg] = { token: t, createdAt: now };
    if (state.event.status === 'r1') initPlayerR1(p);
    saveState();
    sendSubmissionToCloud('login', { registerno: reg, name, department: dept });
    return { sessionToken: t, state: publicState(p) };
  }

  // Participant Logout
  if (path === '/logout') {
    const p = getSessionPlayer();
    if (p) {
      p.active = false;
      delete state.sessions[p.registerno];
      saveState();
      sendSubmissionToCloud('logout', { registerno: p.registerno });
    }
    return { ok: true };
  }

  // Participant Me
  if (path === '/me') {
    const p = getSessionPlayer();
    if (!p) throw new Error('Your session is not active. Please log in again.');
    if (state.event.status === 'r2' && !state.event.pauseAt) ensureR2Deadline(p);
    return publicState(p);
  }

  // Round 1 Draft
  if (path === '/r1/draft') {
    const p = getSessionPlayer();
    if (!p) throw new Error('Session inactive.');
    if (state.event.pauseAt) throw new Error('The event is paused by the host.');
    if (state.event.status !== 'r1' || p.r1LockedOut) throw new Error('Round 1 is not accepting answers.');
    const cur = r1QuestionFor(p);
    if (!cur || cur.waiting || now >= cur.deadline) throw new Error('This question has closed.');
    if (Number(body.questionNumber) !== cur.number) throw new Error('This question has already advanced.');
    const ids = (p.r1Options[cur.id] || []).map(x => x.id);
    if (!ids.includes(body.optionId)) throw new Error('Invalid option.');
    p.r1Drafts[cur.id] = body.optionId;
    saveState();
    sendSubmissionToCloud('r1-draft', { registerno: p.registerno, qid: cur.id, optionId: body.optionId });
    return { ok: true };
  }

  // Round 1 Submit
  if (path === '/r1/submit') {
    const p = getSessionPlayer();
    if (!p) throw new Error('Session inactive.');
    if (state.event.pauseAt) throw new Error('The event is paused by the host.');
    if (state.event.status !== 'r1' || p.r1LockedOut) throw new Error('Round 1 is not accepting answers.');
    const cur = r1QuestionFor(p);
    if (!cur || cur.waiting) throw new Error('No open question.');
    if (Number(body.questionNumber) !== cur.number) throw new Error('This question has already been submitted.');
    if (now >= cur.deadline) {
      ensureR1Current(p);
      throw new Error('The 20-second question time has expired. The next question is ready.');
    }
    const optionId = body.optionId || p.r1Drafts[cur.id] || null;
    recordR1(p, optionId, false, now);
    const nextNumber = r1Index(p);
    let next = null;
    if (nextNumber < 30 && !p.r1LockedOut && !p.r1Done) {
      const nextId = p.r1Order[nextNumber], nextQ = r1.find(x => x.id === nextId), nextOpened = p.r1QuestionOpenedAt || now;
      next = {
        id: nextQ.id,
        number: nextNumber + 1,
        difficulty: nextQ.difficulty,
        topic: nextQ.topic,
        question: nextQ.question,
        options: p.r1Options[nextId],
        selectedOptionId: p.r1Drafts?.[nextId] || null,
        deadline: nextOpened + SLOT * 1000,
        openedAt: nextOpened
      };
    }
    saveState();
    sendSubmissionToCloud('r1-submit', { registerno: p.registerno, optionId, submissionTime: now, timedOut: false });
    return { ok: true, locked: true, submissionTime: p.r1Answers[cur.id].submissionTime, score: r1Score(p), next };
  }

  // Anti-cheat violation report
  if (path === '/monitor/violation') {
    const p = getSessionPlayer();
    if (!p) throw new Error('Session inactive.');
    const round = state.event.status === 'r1' ? 'Round 1' : state.event.status === 'r2' && p.finalist ? 'Round 2' : null;
    if (!round) throw new Error('Monitoring is not active for your current event state.');
    p.r1Violations = p.r1Violations || [];
    const type = ['visibility-hidden', 'window-blur', 'fullscreen-exit'].includes(body.type) ? body.type : null;
    if (!type) throw new Error('Invalid event type.');
    const last = p.lastViolationAt || 0;
    if (now - last < 1200) return { ok: true, debounced: true };
    p.lastViolationAt = now;
    p.r1Violations.push({ type, round, timestamp: now });
    if (p.r1Violations.length >= 2) {
      p.r1PendingReview = true;
      if (round === 'Round 1') {
        ensureR1Current(p);
        if (r1Index(p) < 30) {
          const qid = p.r1Order[r1Index(p)], oid = p.r1Drafts?.[qid] || null;
          recordR1(p, oid, false, now);
        }
        p.r1LockedOut = true;
      }
    }
    saveState();
    sendSubmissionToCloud('violation', { registerno: p.registerno, type, round });
    return { ok: true, count: p.r1Violations.length, lockedOut: !!p.r1LockedOut, pendingReview: !!p.r1PendingReview, round };
  }

  // Round 2 Draft
  if (path === '/r2/draft') {
    const p = getSessionPlayer();
    if (!p) throw new Error('Session inactive.');
    if (state.event.pauseAt) throw new Error('The event is paused by the host.');
    if (state.event.status !== 'r2' || !p.finalist) throw new Error('Round 2 is not available.');
    const cur = r2Current(p);
    if (!cur) throw new Error('No open question.');
    if (now >= cur.deadline) {
      ensureR2Deadline(p);
      throw new Error('This question has closed.');
    }
    const n = Object.keys(p.r2Answers).length;
    if (Number(body.questionNumber) !== cur.number) throw new Error('Question advanced.');
    p.r2Drafts[n] = String(body.answer || '').slice(0, 200);
    saveState();
    sendSubmissionToCloud('r2-draft', { registerno: p.registerno, number: cur.number, answer: p.r2Drafts[n] });
    return { ok: true };
  }

  // Round 2 Hint
  if (path === '/r2/hint') {
    const p = getSessionPlayer();
    if (!p) throw new Error('Session inactive.');
    if (state.event.pauseAt) throw new Error('The event is paused by the host.');
    if (state.event.status !== 'r2' || !p.finalist) throw new Error('Round 2 is not available.');
    const cur = r2Current(p);
    if (!cur) throw new Error('No open question.');
    const n = Object.keys(p.r2Answers).length;
    p.r2HintRevealed = p.r2HintRevealed || {};
    p.r2HintRevealed[n] = true;
    saveState();
    sendSubmissionToCloud('r2-hint', { registerno: p.registerno, number: cur.number });
    return { hint: cases[p.caseId].questions[n].hint };
  }

  // Round 2 Submit
  if (path === '/r2/submit') {
    const p = getSessionPlayer();
    if (!p) throw new Error('Session inactive.');
    if (state.event.pauseAt) throw new Error('The event is paused by the host.');
    if (state.event.status !== 'r2' || !p.finalist) throw new Error('Round 2 is not available.');
    const n = Object.keys(p.r2Answers || {}).length, cur = r2Current(p);
    if (!cur) throw new Error('No open question.');
    const answer = typeof body.answer === 'string' ? body.answer : (p.r2Drafts[n] || '');
    recordR2(p, n, answer, now >= cur.deadline);
    saveState();
    sendSubmissionToCloud('r2-submit', { registerno: p.registerno, number: cur.number, answer, timedOut: now >= cur.deadline });
    return { ok: true, score: r2Score(p), submissionTime: p.r2Answers[n].answeredAt, state: publicState(p) };
  }

  // Leaderboard
  if (path === '/leaderboard') {
    if (!state.event.leaderboardVisible) throw new Error('Public leaderboard is not currently visible.');
    const rows = standings().map((p, i) => ({
      rank: i + 1,
      name: p.name,
      department: p.department,
      r1: p.r1,
      r2: p.r2,
      total: p.total
    }));
    return { players: rows };
  }

  // Winners
  if (path === '/winners') {
    if (!state.event.winnersPublished) throw new Error('Winners have not been published yet.');
    const rows = standings().map((p, i) => ({
      rank: i + 1,
      name: p.name,
      department: p.department,
      register: mask(p.registerno),
      total: p.total
    }));
    return { players: rows };
  }

  // Admin Login
  if (path === '/admin/login') {
    const pass = String(body.password || '').trim();
    if (pass !== ADMIN_PASSWORD_DEFAULT) {
      throw new Error('Incorrect admin password. (Default: ' + ADMIN_PASSWORD_DEFAULT + ')');
    }
    state.adminToken = randomToken();
    saveState();
    return { adminToken: state.adminToken };
  }

  // Admin Overview
  if (path === '/admin/overview') {
    requireAdminAuth();
    const all = Object.values(state.players);
    const ranked = standings();
    const rankedMap = new Map(ranked.map((p, i) => [p.registerno, i + 1]));

    const playersList = all.map(p => {
      const answers = p.r2Answers || {};
      const marks = [0, 1, 2, 3].map(i => {
        if (!answers[i]) return '—';
        return (answers[i].correct ? '✓ ' : '✗ ') + answers[i].points + 'p' + (answers[i].hintUsed ? ' (hint)' : '');
      });
      return {
        registerno: p.registerno,
        name: p.name,
        department: p.department,
        rank: rankedMap.get(p.registerno) || '—',
        r1: r1Score(p),
        r2: r2Score(p),
        total: r1Score(p) + r2Score(p),
        r2Marks: marks,
        r2Time: r2Time(p).time,
        finalist: !!p.finalist,
        caseId: p.caseId,
        active: !!p.active,
        recoveryEnabled: !!p.recoveryEnabled,
        violations: (p.r1Violations || []).length,
        review: p.r1Disqualified ? 'Disqualified' : p.r1LockedOut ? 'Locked out' : p.r1PendingReview ? 'Pending review' : 'Clear'
      };
    });

    const submissions = [];
    for (const p of all) {
      for (const [qid, ans] of Object.entries(p.r1Answers || {})) {
        submissions.push({
          submittedAt: ans.submissionTime || ans.answeredAt,
          name: p.name,
          round: 'Round 1',
          number: (p.r1Order || []).indexOf(Number(qid)) + 1,
          answer: ans.answer,
          correct: ans.correct,
          score: ans.correct ? ans.points : 0
        });
      }
      for (const [idx, ans] of Object.entries(p.r2Answers || {})) {
        submissions.push({
          submittedAt: ans.answeredAt,
          name: p.name,
          round: 'Round 2',
          number: Number(idx) + 1,
          answer: ans.answer,
          correct: ans.correct,
          score: ans.correct ? (ans.points - (ans.hintUsed ? 1 : 0)) : 0
        });
      }
    }
    submissions.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

    const pending = all.filter(p => p.r1PendingReview && !p.r1Disqualified).map(p => ({
      registerno: p.registerno,
      name: p.name,
      violations: p.r1Violations || []
    }));

    const answerReview = [];
    for (const p of all) {
      if (!p.finalist || !p.caseId) continue;
      for (const [idx, ans] of Object.entries(p.r2Answers || {})) {
        if (!ans.correct && ans.answer) {
          answerReview.push({
            registerno: p.registerno,
            name: p.name,
            caseId: p.caseId,
            number: Number(idx) + 1,
            answer: ans.answer
          });
        }
      }
    }

    return {
      participants: all.length,
      loggedIn: all.filter(p => p.active).length,
      finalists: all.filter(p => p.finalist).length,
      pendingReviews: pending.length,
      currentR1Slot: state.event.r1StartedAt ? r1Slot(state.event.r1StartedAt, now, SLOT, state.event.pausedMs || 0) : 0,
      event: state.event,
      players: playersList,
      submissions,
      pending,
      answerReview,
      audit: state.audit || []
    };
  }

  if (path === '/admin/start-r1') {
    requireAdminAuth();
    state.event.status = 'r1';
    state.event.r1StartedAt = now;
    state.event.r1EndsAt = now + 30 * SLOT * 1000;
    Object.values(state.players).forEach(p => initPlayerR1(p));
    audit('start-r1', 'admin', 'event', 'upcoming', 'r1', 'Round 1 launched');
    saveState();
    return { ok: true };
  }

  if (path === '/admin/end-r1') {
    requireAdminAuth();
    state.event.status = 'r1-ended';
    state.event.r1EndsAt = now;
    Object.values(state.players).forEach(p => {
      ensureR1Current(p);
      p.r1Done = true;
    });
    audit('end-r1', 'admin', 'event', 'r1', 'r1-ended', 'Round 1 ended by host');
    saveState();
    return { ok: true };
  }

  if (path === '/admin/qualify') {
    requireAdminAuth();
    const limit = Math.max(1, Number(body.finalists || 12));
    const playersArr = Object.values(state.players).map(p => ({ ...p, r1: r1Score(p) }));
    const qualified = qualifyPlayers(playersArr, limit);
    const qRegs = new Set(qualified.map(p => p.registerno));
    const caseKeys = ['A', 'B', 'C'];
    let idx = 0;
    for (const p of Object.values(state.players)) {
      if (qRegs.has(p.registerno)) {
        p.finalist = true;
        p.caseId = caseKeys[idx % caseKeys.length];
        idx++;
      } else {
        p.finalist = false;
      }
    }
    state.event.status = 'qualified';
    state.event.finalistsLimit = limit;
    audit('qualify', 'admin', 'players', '', `Qualified ${qualified.length} finalists`, 'Finalists qualification');
    saveState();
    return { ok: true, count: qualified.length };
  }

  if (path === '/admin/start-r2') {
    requireAdminAuth();
    state.event.status = 'r2';
    state.event.r2StartedAt = now;
    state.event.r2EndsAt = now + R2_TOTAL_MS;
    for (const p of Object.values(state.players)) {
      if (p.finalist) p.r2OpenedAt = now;
    }
    audit('start-r2', 'admin', 'event', 'qualified', 'r2', 'Round 2 launched');
    saveState();
    return { ok: true };
  }

  if (path === '/admin/end-r2') {
    requireAdminAuth();
    state.event.status = 'r2-ended';
    state.event.r2EndsAt = now;
    for (const p of Object.values(state.players)) {
      if (p.finalist) {
        p.r2Done = true;
      }
    }
    audit('end-r2', 'admin', 'event', 'r2', 'r2-ended', 'Round 2 ended by host');
    saveState();
    return { ok: true };
  }

  if (path === '/admin/pause') {
    requireAdminAuth();
    state.event.pauseAt = now;
    audit('pause', 'admin', 'event', 'running', 'paused', 'Event emergency paused');
    saveState();
    return { ok: true };
  }

  if (path === '/admin/resume') {
    requireAdminAuth();
    if (state.event.pauseAt) {
      state.event.pausedMs = (state.event.pausedMs || 0) + (now - state.event.pauseAt);
      state.event.pauseAt = null;
    }
    audit('resume', 'admin', 'event', 'paused', 'running', 'Event resumed');
    saveState();
    return { ok: true };
  }

  if (path === '/admin/publish') {
    requireAdminAuth();
    state.event.status = 'completed';
    state.event.winnersPublished = true;
    state.event.leaderboardVisible = true;
    audit('publish', 'admin', 'event', '', 'completed', 'Winners published');
    saveState();
    return { ok: true };
  }

  if (path === '/admin/reset') {
    requireAdminAuth();
    if (body.confirm !== 'RESET') throw new Error('Type RESET to confirm.');
    state = blankState();
    saveState();
    return { ok: true };
  }

  if (path === '/admin/login-toggle') {
    requireAdminAuth();
    state.event.loginOpen = !!body.open;
    audit('login-toggle', 'admin', 'registration', '', String(body.open), 'Toggled participant login');
    saveState();
    return { ok: true };
  }

  if (path === '/admin/leaderboard-toggle') {
    requireAdminAuth();
    state.event.leaderboardVisible = !!body.visible;
    audit('leaderboard-toggle', 'admin', 'leaderboard', '', String(body.visible), 'Toggled public leaderboard');
    saveState();
    return { ok: true };
  }

  if (path === '/admin/restore') {
    requireAdminAuth();
    const p = state.players[body.registerno];
    if (!p) throw new Error('Player not found.');
    p.r1LockedOut = false;
    p.r1PendingReview = false;
    p.r1Violations = [];
    audit('restore', 'admin', body.registerno, 'flagged', 'restored', body.reason);
    saveState();
    return { ok: true };
  }

  if (path === '/admin/disqualify') {
    requireAdminAuth();
    const p = state.players[body.registerno];
    if (!p) throw new Error('Player not found.');
    p.r1Disqualified = true;
    p.r1LockedOut = true;
    p.r1PendingReview = false;
    audit('disqualify', 'admin', body.registerno, 'active', 'disqualified', body.reason);
    saveState();
    return { ok: true };
  }

  if (path === '/admin/review-answer') {
    requireAdminAuth();
    const p = state.players[body.registerno];
    if (!p) throw new Error('Player not found.');
    const ans = p.r2Answers?.[body.number - 1];
    if (!ans) throw new Error('Answer record not found.');
    ans.correct = true;
    ans.points = cases[p.caseId].questions[body.number - 1].points - (ans.hintUsed ? 1 : 0);
    audit('review-answer', 'admin', body.registerno, 'incorrect', 'correct', body.reason);
    saveState();
    return { ok: true };
  }

  if (path === '/admin/roster') {
    requireAdminAuth();
    const csv = String(body.csv || '');
    const lines = csv.trim().split(/\r?\n/).slice(1);
    const roster = {};
    for (const line of lines) {
      const [name, reg, dept] = line.split(',').map(x => x.trim());
      if (name && /^\d{6,15}$/.test(reg || '') && /^[a-zA-Z0-9]{2,12}$/.test(dept || '')) {
        roster[reg] = { name, department: dept.toUpperCase() };
      }
    }
    state.roster = roster;
    audit('roster-upload', 'admin', 'roster', '', `${Object.keys(roster).length} entries`, 'Uploaded roster CSV');
    saveState();
    return { ok: true, count: Object.keys(roster).length };
  }

  if (path === '/admin/recovery') {
    requireAdminAuth();
    const p = state.players[body.registerno];
    if (!p) throw new Error('Player not found.');
    p.recoveryEnabled = !!body.enabled;
    audit('recovery', 'admin', body.registerno, '', String(body.enabled), body.reason);
    saveState();
    return { ok: true };
  }

  if (path === '/admin/sudden-death') {
    requireAdminAuth();
    state.suddenDeath = { winnerRegisterno: body.winnerRegisterno, reason: body.reason, timestamp: now };
    audit('sudden-death', 'admin', body.winnerRegisterno, '', 'winner', body.reason);
    saveState();
    return { ok: true };
  }

  if (path === '/admin/score-correction') {
    requireAdminAuth();
    const p = state.players[body.registerno];
    if (!p) throw new Error('Player not found.');
    if (body.round === 'r1') p.r1Correction = Number(body.newScore) - (r1Score(p) - (p.r1Correction || 0));
    else p.r2Correction = Number(body.newScore) - (r2Score(p) - (p.r2Correction || 0));
    audit('score-correction', 'admin', body.registerno, body.round, String(body.newScore), body.reason);
    saveState();
    return { ok: true };
  }

  throw new Error('Endpoint not found: ' + endpoint);
}

// Pseudo EventSource for reactive updates
function events(on){
  eventListeners.add(on);
  return {
    addEventListener: (type, fn) => { eventListeners.add(fn); },
    close: () => { eventListeners.delete(on); }
  };
}

// --- FRONTEND VIEW CONTROLLER ---
function el(id){
  const active = document.querySelector('.view.active');
  return (active && active.querySelector('#' + CSS.escape(id))) || document.getElementById(id);
}

function showError(msg){
  const n = el('error');
  if (n) n.textContent = msg;
}

function countdown(deadline, serverNow, target){
  const diff = deadline - (Date.now() + (window.__serverOffset || 0));
  const sec = Math.max(0, Math.ceil(diff / 1000));
  target.textContent = String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  target.classList.toggle('danger', sec <= 5);
  return sec;
}

let activeViewRefresh = null;
function triggerViewRefresh(){
  if (activeViewRefresh) activeViewRefresh();
  const currentView = document.querySelector('.view.active')?.dataset?.view;
  if (currentView === 'leaderboard') loadLeaderboard();
  if (currentView === 'winners') loadWinners();
}

function showView(){
  loadState();
  const path = location.pathname.replace(/\/$/, '');
  const routeMap = {
    '/admin': 'admin',
    '/admin.html': 'admin',
    '/login.html': 'login',
    '/lobby.html': 'lobby',
    '/game.html': 'game',
    '/leaderboard.html': 'leaderboard',
    '/winners.html': 'winners',
    '/results.html': 'results'
  };
  const name = location.hash ? location.hash.slice(1) : (routeMap[path] || 'home');
  const allowed = ['home', 'login', 'lobby', 'game', 'admin', 'leaderboard', 'winners', 'results'];
  const view = allowed.includes(name) ? name : 'home';
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
  document.title = 'CODE CLASH — ' + view.toUpperCase();

  if (view === 'home') {
    api('/state').then(s => {
      const n = el('status');
      if (n) n.textContent = s.event.status === 'upcoming' ? 'UPCOMING' : s.event.status === 'completed' ? 'COMPLETED' : 'LIVE';
      if (s.event.status !== 'upcoming' || !s.event.loginOpen) el('loginLink')?.classList.add('hidden');
    }).catch(() => {});
  }
  if (view === 'login') initLogin();
  if (view === 'lobby') initLobby();
  if (view === 'game') initGame();
  if (view === 'admin') initAdmin();
  if (view === 'leaderboard') loadLeaderboard();
  if (view === 'winners') loadWinners();
  if (view === 'results') {
    api('/me').then(s => {
      el('name').textContent = s.name;
      el('score').textContent = s.r1FinalScore ?? s.r1Score;
    }).catch(() => location.hash = '#login');
  }
}
window.addEventListener('hashchange', showView);

function initLogin(){
  const f = el('loginForm');
  if (!f || f.dataset.ready) return;
  f.dataset.ready = '1';
  f.addEventListener('submit', async e => {
    e.preventDefault();
    showError('');
    try {
      const d = await api('/login', {
        method: 'POST',
        body: JSON.stringify({
          name: el('name').value,
          registerno: el('reg').value,
          department: el('dept').value,
          consent: el('consent').checked
        })
      });
      localStorage.setItem(SESSION_KEY, d.sessionToken);
      location.hash = '#lobby';
    } catch (x) {
      showError(x.message);
    }
  });
}

function initLobby(){
  const hello = el('hello');
  if (!hello || hello.dataset.ready) return;
  hello.dataset.ready = '1';
  async function refreshLobby(){
    try {
      const s = await api('/me');
      el('hello').textContent = 'Welcome, ' + s.name;
      el('identity').textContent = s.department + ' · Register ' + s.maskedRegister;
      el('count').textContent = s.loggedIn;
      if (['r1', 'r1-ended', 'qualified', 'r2', 'completed'].includes(s.event.status)) {
        location.hash = '#game';
      }
    } catch (e) {
      location.hash = '#login';
    }
  }
  refreshLobby();
  activeViewRefresh = refreshLobby;
  events(refreshLobby);
  el('logout').onclick = async () => {
    try { await api('/logout', { method: 'POST' }); }
    finally {
      localStorage.removeItem(SESSION_KEY);
      location.hash = '#home';
    }
  };
}

function initGame(){
  if (window.__ccGameReady) return;
  window.__ccGameReady = true;
  let current = null, selected = null, tick = null, monitorInstalled = false, monitorEnabled = false;
  const ids = ['countdownPanel', 'r1Panel', 'r1Done', 'visa', 'gameover', 'r2Panel', 'r2Done'];
  function only(id){
    ids.forEach(x => el(x).classList.toggle('hidden', x !== id));
  }

  function monitor(){
    if (monitorInstalled) { monitorEnabled = true; return; }
    monitorInstalled = true;
    monitorEnabled = true;
    let last = 0;
    const send = type => {
      if (!monitorEnabled || Date.now() - last < 1200) return;
      last = Date.now();
      const round = current?.event?.status === 'r2' ? 'Round 2' : 'Round 1';
      api('/monitor/violation', { method: 'POST', body: JSON.stringify({ type }) }).then(d => {
        const target = round === 'Round 2' ? el('monitorNotice') : el('violation');
        target.classList.remove('hidden');
        target.textContent = d.pendingReview
          ? (round + ' monitoring events have been recorded for admin review. Please remain on the event page.')
          : ('Monitoring warning: ' + type.replaceAll('-', ' ') + ' recorded. Further events may be flagged for admin review.');
      }).catch(() => {});
    };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') send('visibility-hidden'); });
    window.addEventListener('blur', () => send('window-blur'));
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) send('fullscreen-exit'); });
  }

  if (el('fullscreenBtn')) {
    el('fullscreenBtn').onclick = async () => {
      try {
        if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
        else el('fullscreenBtn').disabled = true;
      } catch (e) {
        el('fullscreenBtn').textContent = 'Fullscreen unavailable';
      }
    };
  }

  function showR1(s){
    only('r1Panel');
    const q = s.r1;
    if (!q) {
      only('r1Done');
      el('score1').textContent = 'Your answers are recorded. Waiting for the host to close Round 1.';
      return;
    }
    if (q.waiting) {
      el('question').textContent = 'The round begins shortly. Get ready.';
      el('options').innerHTML = '';
      el('submitR1').disabled = true;
      if (tick) clearInterval(tick);
      tick = setInterval(() => {
        const n = countdown(q.deadline, s.serverNow, el('timer'));
        if (el('roundTimer') && s.event.r1EndsAt) countdown(s.event.r1EndsAt, s.serverNow, el('roundTimer'));
        if (n <= 0) { clearInterval(tick); refresh(); }
      }, 200);
      return;
    }
    el('locked').classList.add('hidden');
    el('submitR1').disabled = false;
    el('slot').textContent = `QUESTION ${String(q.number).padStart(2, '0')} / 30`;
    el('topic').textContent = `${q.topic} · ${q.difficulty}`;
    el('question').textContent = q.question;
    el('options').innerHTML = '';
    selected = q.selectedOptionId || null;
    q.options.forEach(o => {
      const b = document.createElement('button');
      b.className = 'option' + (o.id === selected ? ' selected' : '');
      b.textContent = o.label;
      b.onclick = () => {
        selected = o.id;
        document.querySelectorAll('.option').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        api('/r1/draft', { method: 'POST', body: JSON.stringify({ optionId: o.id, questionNumber: q.number }) }).catch(e => showError(e.message));
      };
      el('options').appendChild(b);
    });
    if (tick) clearInterval(tick);
    tick = setInterval(() => {
      const n = countdown(q.deadline, s.serverNow, el('timer'));
      if (el('roundTimer') && s.event.r1EndsAt) countdown(s.event.r1EndsAt, s.serverNow, el('roundTimer'));
      if (n <= 0) { clearInterval(tick); refresh(); }
    }, 200);
    el('submitR1').onclick = async () => {
      try {
        el('submitR1').disabled = true;
        await api('/r1/submit', { method: 'POST', body: JSON.stringify({ optionId: selected, questionNumber: q.number }) });
        await refresh();
      } catch (e) {
        el('submitR1').disabled = false;
        showError(e.message);
      }
    };
  }

  function showR2(s){
    if (s.r2Info?.starting) {
      only('countdownPanel');
      el('countdownPanel').querySelector('.eyebrow').textContent = 'LAB LOCKDOWN STARTS IN';
      if (tick) clearInterval(tick);
      tick = setInterval(() => {
        const n = countdown(s.r2Info.startDeadline, s.serverNow, el('countdown'));
        if (n <= 0) { clearInterval(tick); refresh(); }
      }, 200);
      return;
    }
    if (!s.r2Info?.case) { only('r2Done'); return; }
    const c = s.r2Info.case;
    el('caseTitle').textContent = c.title;
    el('caseDesc').textContent = c.description;
    el('caseGuide').textContent = c.guide || '';
    el('howtoR2').innerHTML = s.r2Info.howItWorks.map(x => '<li>' + escapeHtml(x) + '</li>').join('');
    el('exhibits').innerHTML = '';
    c.exhibits.forEach(([title, body]) => {
      const d = document.createElement('div');
      d.innerHTML = '<h3>' + escapeHtml(title) + '</h3><div class="exhibit">' + escapeHtml(body) + '</div>';
      el('exhibits').appendChild(d);
    });
    el('howto').innerHTML = s.r2Info.howItWorks.map(x => '<li>' + escapeHtml(x) + '</li>').join('');
    if (s.event.status === 'qualified') {
      only('visa');
      el('caseName').textContent = c.title;
      return;
    }
    if (!s.r2Info.question) { only('r2Done'); return; }
    only('r2Panel');
    const q = s.r2Info.question;
    el('question2').textContent = `${q.number}. ${q.question}`;
    el('points2').textContent = `Worth ${q.points} points · Up to 5 minutes`;
    el('answer2').value = q.draft || '';
    el('hintText').classList.toggle('hidden', !q.hintRevealed);
    el('hintBtn').disabled = !!q.hintRevealed;
    if (q.hintRevealed) {
      api('/r2/hint', { method: 'POST', body: JSON.stringify({ questionNumber: q.number }) }).then(d => {
        el('hintText').textContent = d.hint;
        el('hintText').classList.remove('hidden');
      }).catch(() => {});
    }
    if (tick) clearInterval(tick);
    tick = setInterval(() => {
      const n = countdown(q.deadline, s.serverNow, el('timer2'));
      if (el('roundTimer2') && s.event.r2EndsAt) countdown(s.event.r2EndsAt, s.serverNow, el('roundTimer2'));
      if (n <= 0) {
        clearInterval(tick);
        api('/r2/submit', { method: 'POST', body: JSON.stringify({ answer: el('answer2').value, questionNumber: q.number }) }).then(refresh).catch(refresh);
      }
    }, 750);
    let draftTimer;
    el('answer2').oninput = () => {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => api('/r2/draft', { method: 'POST', body: JSON.stringify({ answer: el('answer2').value, questionNumber: q.number }) }).catch(() => {}), 250);
    };
    el('submitR2').onclick = async () => {
      el('submitR2').disabled = true;
      try {
        await api('/r2/submit', { method: 'POST', body: JSON.stringify({ answer: el('answer2').value, questionNumber: q.number }) });
        await refresh();
      } catch (e) {
        el('submitR2').disabled = false;
        el('error2').textContent = e.message;
      }
    };
    el('hintBtn').onclick = async () => {
      if (!confirm('Reveal this hint? A correct answer will lose 1 point. This cannot be undone.')) return;
      try {
        const d = await api('/r2/hint', { method: 'POST', body: JSON.stringify({ questionNumber: q.number }) });
        el('hintText').textContent = d.hint;
        el('hintText').classList.remove('hidden');
        el('hintBtn').disabled = true;
      } catch (e) {
        el('error2').textContent = e.message;
      }
    };
  }

  async function refresh(){
    try {
      const s = await api('/me');
      current = s;
      window.__serverOffset = 0;
      if (s.event.pauseAt) {
        monitorEnabled = false;
        only('countdownPanel');
        el('countdownPanel').querySelector('.eyebrow').textContent = 'EVENT PAUSED BY HOST';
        el('countdown').textContent = 'PAUSED';
        return;
      }
      el('roundTag').textContent = s.event.status.toUpperCase();
      if (s.event.status === 'r1') {
        if (s.r1LockedOut) {
          monitorEnabled = false;
          only('r1Done');
          el('score1').textContent = 'Locked out · Pending Admin Review';
        } else if (!s.r1) {
          monitorEnabled = false;
          only('r1Done');
          el('score1').textContent = 'All 30 answers are recorded. Waiting for the host to close Round 1.';
        } else {
          monitor();
          showR1(s);
        }
      } else if (s.event.status === 'r1-ended') {
        monitorEnabled = false;
        only('r1Done');
        el('score1').textContent = s.r1FinalScore ?? '—';
      } else if (s.event.status === 'qualified') {
        monitorEnabled = false;
        if (s.finalist) showR2(s);
        else {
          only('gameover');
          el('scoreOut').textContent = s.r1FinalScore ?? '—';
        }
      } else if (s.event.status === 'r2') {
        if (s.finalist) {
          monitor();
          showR2(s);
        } else {
          monitorEnabled = false;
          only('gameover');
          el('scoreOut').textContent = s.r1FinalScore ?? '—';
        }
      } else if (s.event.status === 'r2-ended') {
        monitorEnabled = false;
        if (s.finalist) showR2(s);
        else {
          only('gameover');
          el('scoreOut').textContent = s.r1FinalScore ?? '—';
        }
      } else if (s.event.status === 'completed') {
        monitorEnabled = false;
        if (s.finalist) only('r2Done');
        else only('gameover');
      } else {
        monitorEnabled = false;
        location.hash = '#lobby';
      }
    } catch (e) {
      el('error') && (el('error').textContent = e.message);
      if (e.message.includes('session')) location.hash = '#login';
    }
  }

  refresh();
  activeViewRefresh = refresh;
  events(() => refresh());
}

function initAdmin(){
  if (window.__ccAdminReady) return;
  window.__ccAdminReady = true;
  let overview = null;

  function adminToken(){
    return sessionStorage.getItem(ADMIN_KEY) || '';
  }

  // Room displays & tools
  const roomDisp = el('roomCodeDisplay');
  if (roomDisp) roomDisp.textContent = currentRoom;

  const copyBtn = el('copyInviteLink');
  if (copyBtn) {
    copyBtn.onclick = () => {
      const url = new URL(window.location.origin + window.location.pathname);
      url.hash = '#login';
      url.searchParams.set('room', currentRoom);
      const str = url.toString();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(str).then(() => {
          alert('Participant Invite Link copied to clipboard:\n' + str);
        }).catch(() => prompt('Copy Participant Invite Link:', str));
      } else {
        prompt('Copy Participant Invite Link:', str);
      }
    };
  }

  const changeRoomBtn = el('changeRoomBtn');
  if (changeRoomBtn) {
    changeRoomBtn.onclick = () => {
      const code = prompt('Enter new Event Room Code (alphanumeric, no spaces):', currentRoom);
      if (code && code.trim()) {
        currentRoom = code.trim().toLowerCase();
        localStorage.setItem('cc_room_id', currentRoom);
        const url = new URL(window.location.href);
        url.searchParams.set('room', currentRoom);
        window.location.href = url.toString();
      }
    };
  }

  el('adminLogin').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const j = await api('/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password: el('password').value })
      });
      sessionStorage.setItem(ADMIN_KEY, j.adminToken);
      el('login').classList.add('hidden');
      el('dashboard').classList.remove('hidden');
      refresh();
      pushStateToCloud(true);
    } catch (x) {
      el('loginError').textContent = x.message;
    }
  });

  async function refresh(){
    if (!adminToken()) return;
    try {
      overview = await api('/admin/overview');
      el('participants').textContent = overview.participants;
      el('logged').textContent = overview.loggedIn;
      el('status').textContent = overview.event.status;
      el('slotNow').textContent = overview.currentR1Slot + ' / 30';
      el('finalists').textContent = overview.finalists;
      el('pendingCount').textContent = overview.pendingReviews;
      el('loginToggle').textContent = overview.event.loginOpen ? 'Close registration' : 'Open registration';
      el('loginToggle').disabled = overview.event.status !== 'upcoming';
      el('leaderboardToggle').textContent = overview.event.leaderboardVisible ? 'Hide public leaderboard' : 'Show public leaderboard';
      renderPlayers();
      renderReviews();
      renderSubmissions();
      el('auditLog').innerHTML = overview.audit.slice(-30).reverse().map(a =>
        `<p><strong>${escapeHtml(a.action)}</strong> · ${escapeHtml(a.record)} · ${escapeHtml(a.reason)} <span class="muted">${new Date(a.timestamp).toLocaleString()}</span></p>`
      ).join('') || 'No admin actions yet.';
    } catch (e) {
      el('error').textContent = e.message;
    }
  }

  function renderPlayers(){
    const q = el('search').value.toLowerCase(), sort = el('sort').value;
    const rows = overview.players.filter(p => [p.name, p.registerno, p.department].join(' ').toLowerCase().includes(q));
    if (sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort !== 'rank') rows.sort((a, b) => b[sort] - a[sort]);
    el('players').innerHTML = rows.map(p =>
      `<tr><td>${p.rank}</td><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.registerno)}</td><td>${escapeHtml(p.department)}</td><td>${p.r1.toFixed(1)}</td><td>${p.r2}</td><td>${p.total.toFixed(1)}</td>${p.r2Marks.map(m => `<td>${m}</td>`).join('')}<td>${Number.isFinite(p.r2Time) && p.r2Time ? new Date(p.r2Time).toLocaleTimeString() : '—'}</td><td>${p.finalist ? 'Yes' : 'No'}</td><td>${p.active ? 'Active' : 'Offline'}</td><td>${p.recoveryEnabled ? 'Enabled' : '—'}</td><td>${p.violations}</td><td>${escapeHtml(p.review)}</td></tr>`
    ).join('');
  }

  function renderSubmissions(){
    el('submissions').innerHTML = (overview.submissions || []).map(a =>
      `<tr><td>${a.submittedAt ? new Date(a.submittedAt).toLocaleTimeString() : '—'}</td><td>${escapeHtml(a.name)}</td><td>${a.round}</td><td>Q${a.number}</td><td>${escapeHtml(a.answer || '(blank)')}</td><td>${a.correct ? 'Correct' : 'Incorrect / blank'}</td><td>${a.score}</td></tr>`
    ).join('') || '<tr><td colspan="7">No submissions yet.</td></tr>';
  }

  function renderReviews(){
    el('pending').innerHTML = overview.pending.length ? overview.pending.map(p =>
      `<div class="panel"><strong>${escapeHtml(p.name)} · ${escapeHtml(p.registerno)}</strong><p class="muted">${p.violations.map(v => new Date(v.timestamp).toLocaleTimeString() + ' · ' + escapeHtml(v.round || 'Round 1') + ' · ' + escapeHtml(v.type)).join('<br>')}</p><input id="reason-${p.registerno}" placeholder="Required reason"><div class="actions"><button class="btn" onclick="reviewPlayer('${p.registerno}','restore')">Restore</button><button class="btn pinkbtn" onclick="reviewPlayer('${p.registerno}','disqualify')">Disqualify</button></div></div>`
    ).join('') : 'No pending reviews.';

    el('answerReview').innerHTML = overview.answerReview.length ? overview.answerReview.map(a =>
      `<div class="panel"><strong>${escapeHtml(a.name)} · ${a.caseId} Q${a.number}</strong><p>${escapeHtml(a.answer)}</p><input id="ans-${a.registerno}-${a.number}" placeholder="Required reason"><button class="btn" onclick="acceptAnswer('${a.registerno}',${a.number})">Accept as correct</button></div>`
    ).join('') : 'No answers awaiting review.';
  }

  window.reviewPlayer = async (registerno, action) => {
    const reason = el('reason-' + registerno).value;
    if (!reason.trim()) return alert('A reason is required.');
    if (!confirm('Confirm ' + action + ' for ' + registerno + '?')) return;
    try {
      await api('/admin/' + action, { method: 'POST', body: JSON.stringify({ registerno, reason }) });
      refresh();
    } catch (e) {
      alert(e.message);
    }
  };

  window.acceptAnswer = async (registerno, number) => {
    const reason = el(`ans-${registerno}-${number}`).value;
    if (!reason.trim()) return alert('A reason is required.');
    if (!confirm('Accept this Round 2 answer as correct?')) return;
    try {
      await api('/admin/review-answer', { method: 'POST', body: JSON.stringify({ registerno, number, reason }) });
      refresh();
    } catch (e) {
      alert(e.message);
    }
  };

  document.querySelectorAll('[data-action]').forEach(b => b.onclick = async () => {
    const a = b.dataset.action;
    if (['start-r1', 'end-r1', 'start-r2', 'end-r2', 'publish', 'pause', 'resume'].includes(a) && !confirm('Confirm ' + a.replaceAll('-', ' ') + '?')) return;
    try {
      await api('/admin/' + a, { method: 'POST', body: '{}' });
      refresh();
      pushStateToCloud(true);
    } catch (e) {
      alert(e.message);
    }
  });

  el('qualify').onclick = async () => {
    const n = prompt('Number of finalists (ties at cutoff also qualify):', '12');
    if (n === null) return;
    try {
      await api('/admin/qualify', { method: 'POST', body: JSON.stringify({ finalists: n }) });
      refresh();
      pushStateToCloud(true);
    } catch (e) {
      alert(e.message);
    }
  };

  el('reset').onclick = async () => {
    const v = prompt('Type RESET to permanently clear event data:');
    if (v !== 'RESET') return;
    try {
      await api('/admin/reset', { method: 'POST', body: JSON.stringify({ confirm: v }) });
      sessionStorage.removeItem(ADMIN_KEY);
      location.reload();
    } catch (e) {
      alert(e.message);
    }
  };

  el('search').oninput = renderPlayers;
  el('sort').onchange = renderPlayers;

  el('uploadRoster').onclick = async () => {
    try {
      const d = await api('/admin/roster', { method: 'POST', body: JSON.stringify({ csv: el('rosterCsv').value }) });
      alert('Roster entries loaded: ' + d.count);
    } catch (e) {
      alert(e.message);
    }
  };

  el('correct').onclick = async () => {
    const registerno = el('corReg').value, round = el('corRound').value, newScore = Number(el('corScore').value), reason = el('corReason').value;
    if (!registerno || !reason.trim()) return alert('Register number and reason required.');
    if (!confirm('Apply this score correction?')) return;
    try {
      await api('/admin/score-correction', { method: 'POST', body: JSON.stringify({ registerno, round, newScore, reason }) });
      refresh();
    } catch (e) {
      alert(e.message);
    }
  };

  if (adminToken()) {
    el('login').classList.add('hidden');
    el('dashboard').classList.remove('hidden');
    refresh();
  }
  activeViewRefresh = refresh;
  events(() => refresh());

  el('suddenDeath').onclick = async () => {
    const winnerRegisterno = el('sdReg').value, reason = el('sdReason').value;
    if (!winnerRegisterno || !reason.trim()) return alert('Winner register number and reason are required.');
    try {
      await api('/admin/sudden-death', { method: 'POST', body: JSON.stringify({ winnerRegisterno, reason }) });
      refresh();
      alert('Sudden-death decision recorded.');
    } catch (e) {
      alert(e.message);
    }
  };

  function downloadFile(content, fileName, mimeType = 'text/plain'){
    const blob = new Blob([content], { type: mimeType });
    const a = document.createElement('a');
    const u = URL.createObjectURL(blob);
    a.href = u;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(u);
  }

  el('export').onclick = () => {
    const ranked = standings();
    let csv = 'rank,name,registerno,department,r1,r2,total,r2time\n';
    for (let i = 0; i < ranked.length; i++) {
      const p = ranked[i];
      csv += `${i + 1},"${p.name}","${p.registerno}","${p.department}",${p.r1},${p.r2},${p.total},${Number.isFinite(p.r2time) ? p.r2time : ''}\n`;
    }
    downloadFile(csv, 'code-clash-results.csv', 'text/csv');
  };

  el('violationsExport').onclick = () => {
    let csv = 'timestamp,registerno,name,department,round,type\n';
    for (const p of Object.values(state.players)) {
      for (const v of p.r1Violations || []) {
        csv += `"${new Date(v.timestamp).toISOString()}","${p.registerno}","${p.name}","${p.department}","${v.round}","${v.type}"\n`;
      }
    }
    downloadFile(csv, 'code-clash-violations.csv', 'text/csv');
  };

  el('backup').onclick = () => {
    const snapshot = { ...state };
    delete snapshot.adminToken;
    downloadFile(JSON.stringify(snapshot, null, 2), 'code-clash-backup.json', 'application/json');
  };

  // Restore JSON backup
  const importBtn = el('importBackupBtn');
  const importFile = el('importBackupFile');
  if (importBtn && importFile) {
    importBtn.onclick = () => importFile.click();
    importFile.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const parsed = JSON.parse(evt.target.result);
          if (!parsed.event || !parsed.players) throw new Error('Invalid Code Clash backup file structure.');
          state = { ...blankState(), ...parsed };
          state.event = { ...blankState().event, ...(parsed.event || {}) };
          saveState(true, true);
          alert('Backup restored successfully! Total players: ' + Object.keys(state.players).length);
          refresh();
        } catch (err) {
          alert('Failed to restore backup: ' + err.message);
        }
      };
      reader.readAsText(file);
    };
  }

  // Load 12 rehearsal participants button
  const seedBtn = el('seedDemoBtn');
  if (seedBtn) {
    seedBtn.onclick = () => {
      if (!confirm('Load 12 demo rehearsal participants?')) return;
      for (let i = 1; i <= 12; i++) {
        const registerno = String(90000000000 + i);
        const name = `Rehearsal Player ${String(i).padStart(2, '0')}`;
        if (!state.players[registerno]) {
          const p = {
            registerno,
            name,
            department: i % 2 === 0 ? 'CSE' : 'IT',
            createdAt: Date.now(),
            active: false,
            consentAt: Date.now(),
            r1Answers: {},
            r1Drafts: {},
            r2Answers: {},
            r2Drafts: {}
          };
          initPlayerR1(p);
          for (let qIdx = 0; qIdx < 30; qIdx++) {
            const qid = p.r1Order[qIdx];
            const q = r1.find(x => x.id === qid);
            const isCorrect = (qIdx + i) % 3 !== 0;
            p.r1Answers[qid] = {
              optionId: 'demo-opt',
              answer: isCorrect ? q.answer : 'wrong',
              correct: isCorrect,
              points: q.points,
              openedAt: Date.now() - 30000,
              answeredAt: Date.now() - 10000,
              submissionTime: Date.now() - 10000,
              timeTaken: 10 + (i % 5),
              timedOut: false
            };
          }
          p.r1Done = true;
          state.players[registerno] = p;
        }
      }
      audit('seed-demo', 'admin', 'players', '', '12 players', 'Loaded rehearsal participants');
      saveState(true, true);
      alert('12 Rehearsal participants loaded! You can now test qualifying, Round 2, leaderboards, and podium.');
      refresh();
    };
  }

  el('loginToggle').onclick = async () => {
    const open = !overview.event.loginOpen;
    if (!confirm((open ? 'Open' : 'Close') + ' participant registration?')) return;
    try {
      await api('/admin/login-toggle', { method: 'POST', body: JSON.stringify({ open }) });
      refresh();
    } catch (e) {
      alert(e.message);
    }
  };

  el('leaderboardToggle').onclick = async () => {
    const visible = !overview.event.leaderboardVisible;
    if (!confirm((visible ? 'Show' : 'Hide') + ' the public leaderboard?')) return;
    try {
      await api('/admin/leaderboard-toggle', { method: 'POST', body: JSON.stringify({ visible }) });
      refresh();
    } catch (e) {
      alert(e.message);
    }
  };

  async function setRecovery(enabled){
    const registerno = el('recoveryReg').value, reason = el('recoveryReason').value;
    if (!registerno || !reason.trim()) return alert('Register number and reason are required.');
    try {
      await api('/admin/recovery', { method: 'POST', body: JSON.stringify({ registerno, enabled, reason }) });
      alert('Recovery setting updated.');
      refresh();
    } catch (e) {
      alert(e.message);
    }
  }
  el('enableRecovery').onclick = () => setRecovery(true);
  el('disableRecovery').onclick = () => setRecovery(false);
}

function loadLeaderboard(){
  const msg = el('message');
  if (!msg || !document.getElementById('rows')) return;
  api('/leaderboard').then(d => {
    el('rows').innerHTML = d.players.map(p =>
      `<tr><td>${p.rank}</td><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.department)}</td><td>${p.r1.toFixed(1)}</td><td>${p.r2}</td><td>${p.total.toFixed(1)}</td></tr>`
    ).join('');
    msg.textContent = 'Live standings · updated ' + new Date().toLocaleTimeString();
  }).catch(e => {
    msg.textContent = e.message;
  });
}

function loadWinners(){
  if (!el('podium')) return;
  api('/winners').then(d => {
    const p = d.players;
    el('podium').innerHTML = p.slice(0, 3).map((x, i) =>
      `<article class="panel center"><div class="eyebrow">${['CHAMPION', 'FIRST RUNNER-UP', 'SECOND RUNNER-UP'][i]}</div><div class="countdown">${i + 1}</div><h2>${escapeHtml(x.name)}</h2><p class="muted">${escapeHtml(x.department)} · ${escapeHtml(x.register)}</p><strong>${x.total} / 60</strong></article>`
    ).join('');
    el('rows').innerHTML = p.map(x =>
      `<tr><td>${x.rank}</td><td>${escapeHtml(x.name)}</td><td>${escapeHtml(x.department)}</td><td>${escapeHtml(x.register)}</td><td>${x.total}</td></tr>`
    ).join('');
  }).catch(e => {
    el('error').textContent = e.message;
  });
}

// Initial Boot
loadState();
if (isOnlineMode) {
  if (sessionStorage.getItem(ADMIN_KEY)) {
    pushStateToCloud();
  } else {
    pullStateFromCloud();
  }
}
showView();
