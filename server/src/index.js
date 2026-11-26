// Leon's Ledger API — Cloudflare Worker
// Accounts, budget sync, shared budgets (invite codes) and an AI proxy that uses the owner's Anthropic key.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,authorization,x-device-id',
  'Access-Control-Max-Age': '86400'
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });
const err = (status, message, extra) => json(Object.assign({ error: message }, extra || {}), status);
const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);
const rid = (n = 18) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); };
const MAX_BOOK_BYTES = 4 * 1024 * 1024;

async function hashPassword(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}
function recoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const a = new Uint8Array(16); crypto.getRandomValues(a);
  const s = Array.from(a, (x) => alphabet[x % alphabet.length]).join('');
  return s.match(/.{4}/g).join('-');
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function newRecovery(env, userId) {
  const code = recoveryCode(), salt = rid(16), hash = await hashPassword(normCode(code), salt);
  await env.DB.prepare('UPDATE users SET recovery_hash = ?, recovery_salt = ? WHERE id = ?').bind(hash, salt, userId).run();
  return code;
}
function safeEqual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

async function readJSON(req, limit) {
  const text = await req.text();
  if (text.length > (limit || MAX_BOOK_BYTES)) throw Object.assign(new Error('Request too large'), { status: 413 });
  try { return JSON.parse(text || '{}'); } catch (_) { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

async function auth(req, env) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  return env.DB.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').bind(token).first();
}

async function memberRole(env, bookId, userId) {
  const r = await env.DB.prepare('SELECT role FROM members WHERE book_id = ? AND user_id = ?').bind(bookId, userId).first();
  return r ? r.role : null;
}

async function bump(env, key, limit) {
  const day = today();
  const row = await env.DB.prepare('INSERT INTO usage (k, day, n) VALUES (?, ?, 1) ON CONFLICT(k, day) DO UPDATE SET n = n + 1 RETURNING n').bind(key, day).first();
  return { count: row.n, ok: row.n <= limit };
}

async function handle(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const M = req.method;
  if (M === 'OPTIONS') return new Response(null, { headers: CORS });
  if (p === '/' || p === '/health') return json({ ok: true, service: "Leon's Ledger API" });

  // ---------- accounts ----------
  if (p === '/auth/signup' && M === 'POST') {
    const { username, password } = await readJSON(req, 10000);
    const u = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(u)) return err(400, 'Username must be 3–32 letters, numbers, dots, dashes or underscores.');
    if (String(password || '').length < 8) return err(400, 'Password must be at least 8 characters.');
    const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(u).first();
    if (exists) return err(409, 'That username is taken.');
    const id = 'u_' + rid(10), salt = rid(16), hash = await hashPassword(password, salt), token = rid(32);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id, username, pass_hash, salt, created) VALUES (?, ?, ?, ?, ?)').bind(id, u, hash, salt, now()),
      env.DB.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)').bind(token, id, now())
    ]);
    const recovery = await newRecovery(env, id);
    return json({ token, user: { id, username: u }, recoveryCode: recovery });
  }
  if (p === '/auth/login' && M === 'POST') {
    const { username, password } = await readJSON(req, 10000);
    const u = String(username || '').trim().toLowerCase();
    const ipKey = 'login:' + (req.headers.get('cf-connecting-ip') || 'x');
    if (!(await bump(env, ipKey, 50)).ok) return err(429, 'Too many login attempts today. Try again tomorrow.');
    const row = await env.DB.prepare('SELECT id, username, pass_hash, salt FROM users WHERE username = ?').bind(u).first();
    if (!row || !safeEqual(await hashPassword(String(password || ''), row.salt), row.pass_hash)) return err(401, 'Wrong username or password.');
    const token = rid(32);
    await env.DB.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)').bind(token, row.id, now()).run();
    return json({ token, user: { id: row.id, username: row.username } });
  }

  if (p === '/auth/reset' && M === 'POST') {
    const { username, recoveryCode: code, newPassword } = await readJSON(req, 10000);
    const ip = req.headers.get('cf-connecting-ip') || 'x';
    if (!(await bump(env, 'reset:' + ip, 20)).ok) return err(429, 'Too many attempts today. Try again tomorrow.');
    if (String(newPassword || '').length < 8) return err(400, 'New password must be at least 8 characters.');
    const row = await env.DB.prepare('SELECT id, username, recovery_hash, recovery_salt FROM users WHERE username = ?').bind(String(username || '').trim().toLowerCase()).first();
    if (!row || !row.recovery_hash || !safeEqual(await hashPassword(normCode(code), row.recovery_salt), row.recovery_hash)) return err(401, 'That username and recovery code don’t match.');
    const salt = rid(16), hash = await hashPassword(newPassword, salt), token = rid(32);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').bind(hash, salt, row.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.id),
      env.DB.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)').bind(token, row.id, now())
    ]);
    const fresh = await newRecovery(env, row.id);   // a used code is replaced
    return json({ token, user: { id: row.id, username: row.username }, recoveryCode: fresh });
  }

  // ---------- AI proxy ----------
  if (p === '/ai' && M === 'POST') {
    if (!env.ANTHROPIC_API_KEY) return err(503, 'AI is not set up on the server yet.');
    const user = await auth(req, env);
    const device = (req.headers.get('x-device-id') || '').slice(0, 64);
    const ip = req.headers.get('cf-connecting-ip') || 'x';
    const body = await readJSON(req, 6 * 1024 * 1024);
    if (!Array.isArray(body.messages) || !body.messages.length) return err(400, 'No messages.');
    const g = await bump(env, 'global', Number(env.LIMIT_GLOBAL_PER_DAY));
    if (!g.ok) return err(429, 'The AI is very busy today. Please try again tomorrow.');
    const lim = user ? await bump(env, 'user:' + user.id, Number(env.LIMIT_USER_PER_DAY))
      : await bump(env, 'device:' + (device || ip), Number(env.LIMIT_DEVICE_PER_DAY));
    if (!lim.ok) return err(429, user ? `You've used today's ${env.LIMIT_USER_PER_DAY} AI requests. More tomorrow!` : `You've used today's ${env.LIMIT_DEVICE_PER_DAY} free AI requests. Create a free account in Settings for more.`);
    if (!user && !(await bump(env, 'ip:' + ip, Number(env.LIMIT_IP_PER_DAY))).ok) return err(429, 'Daily AI limit reached for this network.');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: env.AI_MODEL, max_tokens: Math.min(Number(body.max_tokens) || 1200, 1500), system: String(body.system || '').slice(0, 8000), messages: body.messages })
    });
    const out = await res.json();
    if (!res.ok) return err(502, (out.error && out.error.message) || 'AI request failed.');
    const text = (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return json({ text, used: lim.count, limit: Number(user ? env.LIMIT_USER_PER_DAY : env.LIMIT_DEVICE_PER_DAY) });
  }

  // ---------- everything below needs an account ----------
  const user = await auth(req, env);
  if (!user) return err(401, 'Please log in again.');

  if (p === '/auth/logout' && M === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind((req.headers.get('authorization') || '').slice(7)).run();
    return json({ ok: true });
  }
  async function checkPassword(pw) {
    const row = await env.DB.prepare('SELECT pass_hash, salt FROM users WHERE id = ?').bind(user.id).first();
    return row && safeEqual(await hashPassword(String(pw || ''), row.salt), row.pass_hash);
  }
  if (p === '/auth/recovery' && M === 'POST') {
    const { password } = await readJSON(req, 10000);
    if (!(await checkPassword(password))) return err(401, 'Wrong password.');
    return json({ recoveryCode: await newRecovery(env, user.id) });
  }
  if (p === '/auth/password' && M === 'POST') {
    const { oldPassword, newPassword } = await readJSON(req, 10000);
    if (!(await checkPassword(oldPassword))) return err(401, 'Your current password is wrong.');
    if (String(newPassword || '').length < 8) return err(400, 'New password must be at least 8 characters.');
    const salt = rid(16), hash = await hashPassword(newPassword, salt);
    const keep = (req.headers.get('authorization') || '').slice(7);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').bind(hash, salt, user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').bind(user.id, keep)   // log out other devices
    ]);
    return json({ ok: true });
  }
  if (p === '/auth/delete' && M === 'POST') {
    const { password } = await readJSON(req, 10000);
    if (!(await checkPassword(password))) return err(401, 'Wrong password.');
    const books = await env.DB.prepare('SELECT book_id FROM members WHERE user_id = ?').bind(user.id).all();
    const stmts = [env.DB.prepare('DELETE FROM members WHERE user_id = ?').bind(user.id)];
    for (const b of books.results) {
      const others = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE book_id = ? AND user_id != ?').bind(b.book_id, user.id).first();
      if (!others.n) stmts.push(env.DB.prepare('DELETE FROM books WHERE id = ?').bind(b.book_id), env.DB.prepare('DELETE FROM invites WHERE book_id = ?').bind(b.book_id));
    }
    stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM usage WHERE k = ?').bind('user:' + user.id),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id));
    await env.DB.batch(stmts);
    return json({ ok: true, deleted: true });
  }
  if (p === '/me' && M === 'GET') {
    const rec = await env.DB.prepare('SELECT recovery_hash FROM users WHERE id = ?').bind(user.id).first();
    user.hasRecovery = !!(rec && rec.recovery_hash);
    const books = await env.DB.prepare('SELECT b.id, b.name, b.shared, b.rev, b.owner, m.role, (SELECT COUNT(*) FROM members x WHERE x.book_id = b.id) AS members FROM members m JOIN books b ON b.id = m.book_id WHERE m.user_id = ? ORDER BY b.shared, b.name').bind(user.id).all();
    return json({ user, books: books.results });
  }
  if (p === '/books' && M === 'POST') {
    const body = await readJSON(req);
    const id = 'b_' + rid(10);
    const name = String(body.name || 'My budget').slice(0, 60);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO books (id, name, owner, shared, data, rev, updated) VALUES (?, ?, ?, ?, ?, 1, ?)').bind(id, name, user.id, body.shared ? 1 : 0, JSON.stringify(body.data || {}), now()),
      env.DB.prepare('INSERT INTO members (book_id, user_id, role) VALUES (?, ?, ?)').bind(id, user.id, 'owner')
    ]);
    return json({ id, name, rev: 1, shared: !!body.shared });
  }
  if (p === '/join' && M === 'POST') {
    const { code } = await readJSON(req, 1000);
    const inv = await env.DB.prepare('SELECT book_id, expires FROM invites WHERE code = ?').bind(String(code || '').trim().toUpperCase()).first();
    if (!inv || inv.expires < now()) return err(404, 'That invite code is wrong or has expired.');
    await env.DB.prepare('INSERT OR IGNORE INTO members (book_id, user_id, role) VALUES (?, ?, ?)').bind(inv.book_id, user.id, 'member').run();
    const b = await env.DB.prepare('SELECT id, name, rev, shared FROM books WHERE id = ?').bind(inv.book_id).first();
    return json(b);
  }

  const mBook = p.match(/^\/books\/([\w-]+)(\/[\w/-]*)?$/);
  if (mBook) {
    const bookId = mBook[1], sub = mBook[2] || '';
    const role = await memberRole(env, bookId, user.id);
    if (!role) return err(404, 'Budget not found.');
    if (!sub && M === 'GET') {
      const b = await env.DB.prepare('SELECT id, name, rev, shared, data, updated FROM books WHERE id = ?').bind(bookId).first();
      return json({ id: b.id, name: b.name, rev: b.rev, shared: !!b.shared, updated: b.updated, data: JSON.parse(b.data) });
    }
    if (!sub && M === 'PUT') {
      const body = await readJSON(req);
      const text = JSON.stringify(body.data || {});
      if (text.length > MAX_BOOK_BYTES) return err(413, 'Budget too large.');
      const r = await env.DB.prepare('UPDATE books SET data = ?, rev = rev + 1, updated = ?, name = COALESCE(?, name) WHERE id = ? AND rev = ? RETURNING rev').bind(text, now(), body.name || null, bookId, Number(body.baseRev)).first();
      if (!r) {
        const cur = await env.DB.prepare('SELECT rev, data FROM books WHERE id = ?').bind(bookId).first();
        return err(409, 'Changed on another device.', { rev: cur.rev, data: JSON.parse(cur.data) });
      }
      return json({ rev: r.rev });
    }
    if (sub === '/invite' && M === 'POST') {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const a = new Uint8Array(6); crypto.getRandomValues(a);
      const code = Array.from(a, (x) => alphabet[x % alphabet.length]).join('');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM invites WHERE expires < ?').bind(now()),
        env.DB.prepare('INSERT INTO invites (code, book_id, expires) VALUES (?, ?, ?)').bind(code, bookId, now() + 7 * 864e5),
        env.DB.prepare('UPDATE books SET shared = 1 WHERE id = ?').bind(bookId)
      ]);
      return json({ code, expiresInDays: 7 });
    }
    if (sub === '/members' && M === 'GET') {
      const r = await env.DB.prepare('SELECT u.username, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.book_id = ?').bind(bookId).all();
      return json({ members: r.results });
    }
    if (sub === '/leave' && M === 'POST') {
      await env.DB.prepare('DELETE FROM members WHERE book_id = ? AND user_id = ?').bind(bookId, user.id).run();
      const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE book_id = ?').bind(bookId).first();
      if (!left.n) await env.DB.batch([env.DB.prepare('DELETE FROM books WHERE id = ?').bind(bookId), env.DB.prepare('DELETE FROM invites WHERE book_id = ?').bind(bookId)]);
      return json({ ok: true });
    }
  }
  return err(404, 'Not found');
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { return err(e.status || 500, e.status ? e.message : 'Server error'); }
  }
};
