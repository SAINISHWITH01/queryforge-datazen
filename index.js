const http  = require('http');
const https = require('https');
const url   = require('url');
const zlib = require('zlib');
var JSZip = require('jszip');
if (JSZip.default) JSZip = JSZip.default;
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
  if (req.url === '/upload-catalog' && req.method === 'POST') {
    return getBody(req, async function(data) {
      var fusionUrl = (data.fusionUrl || '').trim().replace(/\/+$/, '').replace(/^http:/, 'https:');
      var username  = (data.username  || '').trim();
      var password  = (data.password  || '').trim();

      if (!fusionUrl || !username || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, message: 'Missing fusionUrl, username, or password' }));
      }

      var parsedFusion;
      try {
        parsedFusion = url.parse(fusionUrl);
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, message: 'Invalid Fusion URL: ' + e.message }));
      }

      // Helper: do one HTTP/S request
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

      // Helper: upload BIP object
      async function uploadBIPObject(fusionUrl, username, password, objectType, path, zippedB64) {
        var soap = '<?xml version="1.0" encoding="UTF-8"?>' +
          '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v2="http://xmlns.oracle.com/oxp/service/v2">' +
          '<soapenv:Header/>' +
          '<soapenv:Body>' +
          '<v2:uploadObject>' +
          '<v2:userID>' + username + '</v2:userID>' +
          '<v2:password>' + password + '</v2:password>' +
          '<v2:objectType>' + objectType + '</v2:objectType>' +
          '<v2:reportObjectAbsolutePathURL>' + path + '</v2:reportObjectAbsolutePathURL>' +
          '<v2:objectZippedData>' + zippedB64 + '</v2:objectZippedData>' +
          '</v2:uploadObject>' +
          '</soapenv:Body>' +
          '</soapenv:Envelope>';
        var buf    = Buffer.from(soap, 'utf8');
        var parsed = url.parse(fusionUrl + '/xmlpserver/services/v2/CatalogService');
        return await doRequest(parsed, 'POST', {
          'Content-Type'   : 'text/xml; charset=UTF-8',
          'Content-Length' : buf.length,
          'SOAPAction'     : 'uploadObject',
          'Accept-Encoding': 'identity'
        }, buf);
      }

      var lastStatus = 0;
      var lastBody   = '';
      var uploaded   = false;

      // ── Step 1: Login ──────────────────────────────────────
      var loginSoap = '<?xml version="1.0" encoding="UTF-8"?>' +
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:saw="com.siebel.analytics.web/soap/v2">' +
        '<soapenv:Body>' +
        '<saw:logon>' +
        '<saw:name>' + username + '</saw:name>' +
        '<saw:password>' + password + '</saw:password>' +
        '</saw:logon>' +
        '</soapenv:Body>' +
        '</soapenv:Envelope>';

      var sessionID = '';
      try {
        var loginBuf    = Buffer.from(loginSoap, 'utf8');
        var loginParsed = url.parse(fusionUrl + '/analytics-ws/saw.dll?SoapImpl=nQSessionService');
        var loginResult = await doRequest(loginParsed, 'POST', {
          'Content-Type'   : 'text/xml; charset=UTF-8',
          'Content-Length' : loginBuf.length,
          'SOAPAction'     : 'logon',
          'Accept-Encoding': 'identity'
        }, loginBuf);
        log('REQ', 'Login status: ' + loginResult.status);
        var sessionMatch = loginResult.body.match(/<sessionID[^>]*>([^<]+)<\/sessionID>/i) ||
                           loginResult.body.match(/<sawsoap:sessionID[^>]*>([^<]+)<\/sawsoap:sessionID>/i);
        if (sessionMatch) {
          sessionID = sessionMatch[1];
          log('REQ', 'Session ID obtained: ' + sessionID.substring(0, 20) + '...');
        }
      } catch(e) {
        log('ERR', 'Login failed: ' + e.message);
      }

      if (sessionID) {
        try {

          // ── Step 2: Create folder /shared/Custom/QueryForgeDataZen ──
          log('REQ', 'Creating folder...');
          var createFolderSoap = '<?xml version="1.0" encoding="UTF-8"?>' +
            '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:saw="com.siebel.analytics.web/soap/v2">' +
            '<soapenv:Body>' +
            '<saw:createFolder>' +
            '<saw:path>/shared/Custom/QueryForgeDataZen</saw:path>' +
            '<saw:createIfNotExists>true</saw:createIfNotExists>' +
            '<saw:sessionID>' + sessionID + '</saw:sessionID>' +
            '</saw:createFolder>' +
            '</soapenv:Body>' +
            '</soapenv:Envelope>';
          var folderBuf    = Buffer.from(createFolderSoap, 'utf8');
          var folderParsed = url.parse(fusionUrl + '/analytics-ws/saw.dll?SoapImpl=webCatalogService');
          var folderResult = await doRequest(folderParsed, 'POST', {
            'Content-Type'   : 'text/xml; charset=UTF-8',
            'Content-Length' : folderBuf.length,
            'SOAPAction'     : 'createFolder',
            'Accept-Encoding': 'identity'
          }, folderBuf);
          log('REQ', 'CreateFolder status: ' + folderResult.status);
          log('REQ', 'CreateFolder body: ' + folderResult.body);

          // ── Step 3: Upload Data Model ──────────────────────
          log('REQ', 'Uploading data model...');
          var dataModelXml = '<?xml version="1.0" encoding="utf-8"?>\n' +
            '<dataModel xmlns="http://xmlns.oracle.com/oxp/xmlp" version="2.0" ' +
            'xmlns:xdm="http://xmlns.oracle.com/oxp/xmlp" ' +
            'xmlns:xsd="http://wwww.w3.org/2001/XMLSchema" ' +
            'defaultDataSourceRef="CloudSQLDataModel">\n' +
            '<description><![CDATA[QueryForgeDataZenDataModel_csv]]></description>\n' +
            '<dataProperties>\n' +
            '<property name="include_parameters" value="false"/>\n' +
            '<property name="include_null_Element" value="false"/>\n' +
            '<property name="include_rowsettag" value="false"/>\n' +
            '<property name="xml_tag_case" value="upper"/>\n' +
            '<property name="generate_output_format" value="xml"/>\n' +
            '</dataProperties>\n' +
            '<dataSets>\n' +
            '<dataSet name="sqlResultsSet" type="simple">\n' +
            '<sql dataSourceRef="CloudSQLDataModel" nsQuery="true" sp="true" xmlRowTagName="" bindMultiValueAsCommaSepStr="false">\n' +
            '<![CDATA[DECLARE\n' +
            '    type sys_refcursor is REF CURSOR;\n' +
            '    xdo_cursor  sys_refcursor;\n' +
            '    l_sql_query  RAW(32767);\n' +
            '    var11       CLOB := \'\';\n' +
            '    l_encoded_clob CLOB := :sql_query;\n' +
            '    l_decoded_clob CLOB;\n' +
            '    l_chunk_size INTEGER := 32000;\n' +
            '    l_buffer VARCHAR2(32767);\n' +
            '    l_pos INTEGER := 1;\n' +
            '    l_length INTEGER := DBMS_LOB.getlength(l_encoded_clob);\n' +
            'BEGIN\n' +
            '    DBMS_LOB.createtemporary(l_decoded_clob, TRUE);\n' +
            '    WHILE l_pos <= l_length LOOP\n' +
            '        DBMS_LOB.READ(l_encoded_clob, l_chunk_size, l_pos, l_buffer);\n' +
            '        l_sql_query := UTL_RAW.CAST_TO_RAW(l_buffer);\n' +
            '        var11 := TO_CLOB(UTL_RAW.CAST_TO_VARCHAR2(UTL_ENCODE.BASE64_DECODE(l_sql_query)));\n' +
            '        DBMS_LOB.writeappend(l_decoded_clob, LENGTH(var11), var11);\n' +
            '        l_pos := l_pos + l_chunk_size;\n' +
            '    END LOOP;\n' +
            '    OPEN :xdo_cursor FOR l_decoded_clob;\n' +
            '    DBMS_LOB.freetemporary(l_decoded_clob);\n' +
            'END;]]>\n' +
            '</sql>\n' +
            '</dataSet>\n' +
            '</dataSets>\n' +
            '<output rootName="DATA_DS" uniqueRowName="false">\n' +
            '<nodeList name="sqlResultsSet"/>\n' +
            '</output>\n' +
            '<eventTriggers/>\n' +
            '<lexicals/>\n' +
            '<parameters>\n' +
            '<parameter name="sql_query" dataType="xsd:string" rowPlacement="1">\n' +
            '<input label="sql_query"/>\n' +
            '</parameter>\n' +
            '<parameter name="xdo_cursor" dataType="xsd:string" rowPlacement="1">\n' +
            '<input label="xdo_cursor"/>\n' +
            '</parameter>\n' +
            '</parameters>\n' +
            '<valueSets/>\n' +
            '<bursting/>\n' +
            '</dataModel>';

          var zip1 = new JSZip();
          zip1.file('QueryForgeDataZenDataModel_csv.xdm', dataModelXml);
          var dmZipped = await zip1.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
          var dmB64    = dmZipped.toString('base64');
          var dmResult = await uploadBIPObject(fusionUrl, username, password, 'xdmz',
            '/Custom/QueryForgeDataZen/QueryForgeDataZenDataModel_csv', dmB64);
          log('REQ', 'UploadDM status: ' + dmResult.status);
          log('REQ', 'UploadDM body: ' + dmResult.body);

          // ── Step 4: Upload Report ──────────────────────────
          log('REQ', 'Uploading report...');
          var reportXml = '<?xml version="1.0" encoding="utf-8"?>\n' +
            '<report xmlns="http://xmlns.oracle.com/oxp/xmlp" version="2.0">\n' +
            '<description><![CDATA[QueryForgeDataZenReport_csv]]></description>\n' +
            '<dataModelReference>/Custom/QueryForgeDataZen/QueryForgeDataZenDataModel_csv.xdm</dataModelReference>\n' +
            '<defaultOutputFormat>csv</defaultOutputFormat>\n' +
            '<defaultTemplate>blank</defaultTemplate>\n' +
            '<templates>\n' +
            '<template>\n' +
            '<name>blank</name>\n' +
            '<file>blank.xpt</file>\n' +
            '<outputFormat>csv</outputFormat>\n' +
            '<defaultOutput>true</defaultOutput>\n' +
            '<type>xpt</type>\n' +
            '<locale>en-US</locale>\n' +
            '</template>\n' +
            '</templates>\n' +
            '</report>';

          var zip2 = new JSZip();
          zip2.file('QueryForgeDataZenReport_csv.xdo', reportXml);
          var rptZipped = await zip2.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
          var rptB64    = rptZipped.toString('base64');
          var rptResult = await uploadBIPObject(fusionUrl, username, password, 'xdoz',
            '/Custom/QueryForgeDataZen/QueryForgeDataZenReport_csv', rptB64);
          log('REQ', 'UploadReport status: ' + rptResult.status);
          log('REQ', 'UploadReport body: ' + rptResult.body);

          // ── Step 5: Upload Blank Template ─────────────────
          log('REQ', 'Uploading template...');
          var templateXml = '<?xml version="1.0" encoding="utf-8"?>\n' +
            '<xsl:stylesheet version="1.0" ' +
            'xmlns:xsl="http://www.w3.org/1999/XSL/Transform">\n' +
            '<xsl:output method="text" encoding="utf-8"/>\n' +
            '<xsl:template match="/">\n' +
            '<xsl:for-each select="//ROW">\n' +
            '<xsl:value-of select="."/>\n' +
            '</xsl:for-each>\n' +
            '</xsl:template>\n' +
            '</xsl:stylesheet>';

          var zip3 = new JSZip();
          zip3.file('blank.xpt', templateXml);
          var tplZipped = await zip3.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
          var tplB64    = tplZipped.toString('base64');
          var tplResult = await uploadBIPObject(fusionUrl, username, password, 'xssz',
            '/Custom/QueryForgeDataZen/QueryForgeDataZenReport_csv/blank', tplB64);
          log('REQ', 'UploadTemplate status: ' + tplResult.status);
          log('REQ', 'UploadTemplate body: ' + tplResult.body);

          lastStatus = tplResult.status;
          lastBody   = tplResult.body;

          if (dmResult.status === 200 && !dmResult.body.includes('Fault') &&
              rptResult.status === 200 && !rptResult.body.includes('Fault') &&
              tplResult.status === 200 && !tplResult.body.includes('Fault')) {
            uploaded = true;
          }

        } catch(e) {
          log('ERR', 'Error: ' + e.message);
          lastBody = e.message;
        }

      } else {
        lastStatus = 401;
        lastBody = 'Could not obtain session token — check credentials';
      }

      if (uploaded) {
        log('OK', 'All objects deployed successfully');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Deployed successfully', status: lastStatus }));
      } else {
        log('ERR', 'Failed — last status: ' + lastStatus);
        res.writeHead(lastStatus || 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: 'Failed', detail: lastBody, status: lastStatus }));
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
