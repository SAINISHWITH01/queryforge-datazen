const http  = require('http');
const https = require('https');
const url   = require('url');
const zlib = require('zlib');
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

// ── UPLOAD CATALOG ────────────────────────────────────────────
  // POST /upload-catalog
  // Body (JSON): { fusionUrl, username, password }
  if (req.url === '/upload-catalog' && req.method === 'POST') {
    return getBody(req, async function(data) {
      var fusionUrl = (data.fusionUrl || '').trim().replace(/\/+$/, '').replace(/^http:/, 'https:');
      var username  = (data.username  || '').trim();
      var password  = (data.password  || '').trim();

      if (!fusionUrl || !username || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, message: 'Missing fusionUrl, username, or password' }));
      }

      var CATALOG_B64 = "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";

      var catalogBuf = Buffer.from(CATALOG_B64, 'base64');

      var parsedFusion;
      try {
        parsedFusion = url.parse(fusionUrl);
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, message: 'Invalid Fusion URL: ' + e.message }));
      }

      var basicAuth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');

      // Helper: do one HTTP/S request and return { status, headers, body }
      function doRequest(parsedUrl, method, headers, body) {
        return new Promise(function(resolve, reject) {
          var protocol = parsedUrl.protocol === 'https:' ? https : http;
          var opts = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.path || '/',
            method: method,
            headers: headers,
            rejectUnauthorized: false
          };
          var r = protocol.request(opts, function(resp) {
            var chunks = [];
            var encoding = resp.headers['content-encoding'];
            var stream = resp;

            if (encoding === 'gzip') {
              stream = resp.pipe(zlib.createGunzip());
            } else if (encoding === 'deflate') {
              stream = resp.pipe(zlib.createInflate());
            }

            stream.on('data', function(c) { chunks.push(c); });
            stream.on('end', function() {
              resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks).toString() });
            });
            stream.on('error', reject);
          });
          r.on('error', reject);
          if (body) r.write(body);
          r.end();
        });
      }

      var uploadPath = '/shared/Custom/';
      var endpoints = [
        '/xmlpserver/services/rest/v1/catalog/uploadArchive?path=' + encodeURIComponent(uploadPath) + '&overwrite=true'
      ];

      var lastStatus = 0;
      var lastBody   = '';
      var uploaded   = false;

      // Step 1: Get OAM session cookie via xmlpserver ping
      var cookieStr = '';
      try {
        var pingParsed = url.parse(fusionUrl + '/xmlpserver/services/rest/v1/catalog');
        var pingResult = await doRequest(pingParsed, 'GET', {
          'Authorization'  : basicAuth,
          'X-Requested-By' : 'XMLHttpRequest',
          'Accept'         : 'application/json',
          'Accept-Encoding': 'identity'
        }, null);
        log('REQ', 'Ping status: ' + pingResult.status);
        var authCookie = pingResult.headers['set-cookie'];
        cookieStr = authCookie ? authCookie.map(function(c) { return c.split(';')[0]; }).join('; ') : '';
        log('REQ', 'Session cookie: ' + (cookieStr ? 'yes' : 'none'));
        log('REQ', 'Ping body: ' + pingResult.body.substring(0, 300));
      } catch(e) {
        log('ERR', 'Ping failed: ' + e.message);
      }

      for (var ei = 0; ei < endpoints.length; ei++) {
        var apiPath = endpoints[ei];
        log('REQ', 'Trying → ' + parsedFusion.hostname + apiPath);

        try {
          var apiParsed = url.parse(fusionUrl + apiPath);
          var result = await doRequest(apiParsed, 'POST', {
            'Authorization'  : basicAuth,
            'Content-Type'   : 'application/octet-stream',
            'Content-Length' : catalogBuf.length,
            'Accept'         : 'application/json',
            'X-Requested-By' : 'XMLHttpRequest',
            'Accept-Encoding': 'identity',
            'Cookie'         : cookieStr
          }, catalogBuf);

          lastStatus = result.status;
          lastBody   = result.body;
          log('REQ', 'Response status: ' + lastStatus);
          log('REQ', 'Response body: ' + lastBody.substring(0, 300));

          if ((result.status === 301 || result.status === 302 || result.status === 303) && result.headers['location']) {
            var redirectUrl = result.headers['location'];
            log('REQ', 'Redirect → ' + redirectUrl);
            lastStatus = 401;
            lastBody = 'Authentication failed — Oracle redirected to: ' + redirectUrl;
            break;
          }

          if (lastStatus === 200 || lastStatus === 201 || lastStatus === 204) {
            uploaded = true;
            break;
          }

          if (lastStatus === 401 || lastStatus === 403) break;

        } catch(e) {
          log('ERR', 'Request error: ' + e.message);
          lastBody = e.message;
        }
      }

      if (uploaded) {
        log('OK', 'Catalog deployed — HTTP ' + lastStatus);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Catalog deployed successfully', status: lastStatus }));
      } else {
        log('ERR', 'All endpoints failed — last status: ' + lastStatus);
        res.writeHead(lastStatus || 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: 'Fusion returned HTTP ' + lastStatus, detail: lastBody, status: lastStatus }));
      }
    });
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
