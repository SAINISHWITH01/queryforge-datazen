const http  = require('http');
const https = require('https');
const url   = require('url');

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const PORT = process.env.PORT || 3737;

// ── ANSI colors for nice terminal output ──
const C = { reset:'\x1b[0m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m', cyan:'\x1b[36m', gray:'\x1b[90m', bold:'\x1b[1m' };

function log(level, msg) {
  var ts  = new Date().toTimeString().slice(0,8);
  var col = level==='OK'?C.green : level==='ERR'?C.red : level==='REQ'?C.cyan : C.yellow;
  console.log(C.gray+'['+ts+'] '+C.reset+col+'['+level+']'+C.reset+' '+msg);
}

// ── Parse body helper ──
function getBody(req, callback) {
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => {
    if (!body) return callback({});
    try {
      callback(JSON.parse(body));
    } catch (e) {
      console.error("JSON parse error:", e);
      callback({});
    }
  });
}

// ── CORS headers helper — applied to EVERY response ──
function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers','*');
}

// ── Create the proxy server ──
var server = http.createServer(function(req, res) {

  // ✅ FIX 1: Set CORS headers FIRST on every request, before any route logic
  setCORSHeaders(res);

  // Handle preflight OPTIONS for ALL routes
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  log('REQ', req.method + ' ' + req.url);

  // ── USER COUNT ─────────────────────────────────────────────────
  // ✅ FIX 2: Added missing /user-count endpoint
  if (req.url === '/user-count' && req.method === 'GET') {
    pool.query('SELECT COUNT(*) FROM users')
      .then(result => {
        const count = parseInt(result.rows[0].count, 10);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count }));
      })
      .catch(err => {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'DB error' }));
      });
    return;
  }

  // ── PING ───────────────────────────────────────────────────────
  if (req.url === '/ping' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── REGISTER ──────────────────────────────────────────────────
  if (req.url === '/register' && req.method === 'POST') {
    return getBody(req, async data => {
      const { name, username, email, password } = data;

      if (!name || !username || !email || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Missing fields' }));
      }

      try {
        const check = await pool.query(
          'SELECT * FROM users WHERE username=$1 OR email=$2',
          [username, email]
        );

        if (check.rows.length > 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'User exists' }));
        }

        await pool.query(
          'INSERT INTO users(name, username, email, password) VALUES($1,$2,$3,$4)',
          [name, username, email, password]
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Registered' }));
        log('OK', 'New user registered: ' + username);

      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'DB error' }));
      }
    });
  }

  // ── LOGIN ─────────────────────────────────────────────────────
  if (req.url === '/login' && req.method === 'POST') {
    return getBody(req, async data => {
      const { identifier, password } = data;

      if (!identifier || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Missing fields' }));
      }

      try {
        const result = await pool.query(
          'SELECT * FROM users WHERE (username=$1 OR email=$1) AND password=$2',
          [identifier, password]
        );

        if (result.rows.length === 0) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'Invalid credentials' }));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          message: 'Login success',
          user: result.rows[0]
        }));
        log('OK', 'Login: ' + identifier);

      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'DB error' }));
      }
    });
  }

  // ── CONNECTIONS ───────────────────────────────────────────────

  // POST /connections — save a new connection
  if (req.url === '/connections' && req.method === 'POST') {
    return getBody(req, async data => {
      const { user_id, name, type, host, port, database_name, username, password } = data;

      if (!user_id || !name || !type) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Missing required fields: user_id, name, type' }));
      }

      try {
        const result = await pool.query(
          `INSERT INTO connections (user_id, name, type, host, port, database_name, username, password)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [user_id, name, type, host || null, port || null, database_name || null, username || null, password || null]
        );

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Connection saved', connection: result.rows[0] }));
        log('OK', 'Connection saved: ' + name + ' for user ' + user_id);

      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'DB error' }));
      }
    });
  }

  // GET /connections?user_id=X — fetch all connections for a user
  if (req.url.startsWith('/connections') && req.method === 'GET') {
    return (async () => {
      const parsedUrl = url.parse(req.url, true);
      const user_id = parsedUrl.query.user_id;

      if (!user_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Missing user_id query param' }));
      }

      try {
        const result = await pool.query(
          'SELECT * FROM connections WHERE user_id=$1 ORDER BY created_at ASC',
          [user_id]
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connections: result.rows }));
        log('OK', 'Fetched ' + result.rows.length + ' connections for user ' + user_id);

      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'DB error' }));
      }
    })();
  }

  // DELETE /connections/:id - remove a connection
  var deleteMatch = req.url.match(/^\/connections\/(\d+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    var connId = parseInt(deleteMatch[1], 10);
    return (async () => {
      try {
        const result = await pool.query('DELETE FROM connections WHERE id=$1 RETURNING id', [connId]);

        if (result.rows.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'Connection not found' }));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Connection deleted' }));
        log('OK', 'Deleted connection id=' + connId);

      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'DB error' }));
      }
    })();
  }

  // ── PROXY (pass-through for everything else) ─────────────────
  var targetUrl = req.headers['x-target-url'];

  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing X-Target-URL header.');
    return;
  }

  var parsed;
  try {
    parsed = url.parse(targetUrl);
  } catch(e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid URL: ' + targetUrl);
    return;
  }

  var fwdHeaders = {};
  Object.keys(req.headers).forEach(function(k) {
    if (k !== 'x-target-url' && k !== 'host' && k !== 'origin' && k !== 'referer') {
      fwdHeaders[k] = req.headers[k];
    }
  });
  fwdHeaders['host'] = parsed.hostname;

  var options = {
    hostname : parsed.hostname,
    port     : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path     : parsed.path || '/',
    method   : req.method,
    headers  : fwdHeaders,
    rejectUnauthorized: false
  };

  log('REQ', req.method + ' → ' + parsed.hostname + options.path);

  var protocol = parsed.protocol === 'https:' ? https : http;

  var proxyReq = protocol.request(options, function(proxyRes) {
    var skip = ['transfer-encoding','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','upgrade'];
    var outHeaders = {};
    Object.keys(proxyRes.headers).forEach(function(k) {
      if (skip.indexOf(k) === -1) outHeaders[k] = proxyRes.headers[k];
    });

    outHeaders['Access-Control-Allow-Origin']  = '*';
    outHeaders['Access-Control-Expose-Headers']= '*';

    res.writeHead(proxyRes.statusCode, outHeaders);
    proxyRes.pipe(res, { end:true });
    log('OK', 'Response ' + proxyRes.statusCode + ' from ' + parsed.hostname);
  });

  proxyReq.on('error', function(e) {
    log('ERR', e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end('Proxy error: ' + e.message);
  });

  req.pipe(proxyReq, { end:true });
});

server.listen(PORT, '0.0.0.0', function() {
  console.log(`Proxy running on port ${PORT}`);
});
