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

// ── Create the proxy server ──
var server = http.createServer(function(req, res) {

  // ── SIMPLE USER STORAGE ──
//if (!global.users) global.users = [];

// Parse body
function getBody(req, callback) {
  let body = '';

  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', () => {
    if (!body) return callback({});

    try {
      const parsed = JSON.parse(body);
      callback(parsed);
    } catch (e) {
      console.error("JSON parse error:", e);
      callback({});
    }
  });
}

// ── REGISTER ──
if (req.url === '/register' && req.method === 'POST') {
  return getBody(req, async data => {
    const { name, username, email, password } = data;
  if (!name || !username || !email || !password) {
  res.writeHead(400, {'Content-Type':'application/json'});
  return res.end(JSON.stringify({ message: 'Missing fields' }));
}
    try {
      const check = await pool.query(
        'SELECT * FROM users WHERE username=$1 OR email=$2',
        [username, email]
      );

      if (check.rows.length > 0) {
        res.writeHead(400, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ message: 'User exists' }));
      }

      await pool.query(
        'INSERT INTO users(name, username, email, password) VALUES($1,$2,$3,$4)',
        [name, username, email, password]
      );

      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ message: 'Registered' }));

    } catch (err) {
      console.error(err);
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ message: 'DB error' }));
    }
  });
}

// ── LOGIN ──
if (req.url === '/login' && req.method === 'POST') {
  return getBody(req, async data => {
    const { identifier, password } = data;

    try {
      const result = await pool.query(
        'SELECT * FROM users WHERE (username=$1 OR email=$1) AND password=$2',
        [identifier, password]
      );

      if (result.rows.length === 0) {
        res.writeHead(401, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ message: 'Invalid credentials' }));
      }

      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({
        message: 'Login success',
        user: result.rows[0]
      }));

    } catch (err) {
      console.error(err);
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ message: 'DB error' }));
    }
  });
}
  
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers','*');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  var targetUrl = req.headers['x-target-url'];

  if (!targetUrl) {
    res.writeHead(400, {'Content-Type':'text/plain'});
    res.end('Missing X-Target-URL header.');
    return;
  }

  var parsed;
  try {
    parsed = url.parse(targetUrl);
  } catch(e) {
    res.writeHead(400, {'Content-Type':'text/plain'});
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
      res.writeHead(502, {'Content-Type':'text/plain'});
    }
    res.end('Proxy error: ' + e.message);
  });

  req.pipe(proxyReq, { end:true });
});

server.listen(PORT, '0.0.0.0', function() {
  console.log(`Proxy running on port ${PORT}`);
});
