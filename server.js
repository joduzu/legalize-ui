const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3737;
const LAWS_DIR = process.env.LAWS_DIR || 'C:/Users/joduz/AppData/Roaming/Claude/legalize-es/spain';
const REPO_DIR = process.env.REPO_DIR || 'C:/Users/joduz/AppData/Roaming/Claude/legalize-es';

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function isValidLawId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) && id.length <= 100;
}

// ===== CACHES =====
const eurlexCache = {};
const historyCache = {};  // lawId -> commits[]
const diffCache = {};     // hash -> diff string

// Async git helper (non-blocking)
function gitAsync(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

function parseHistoryLog(log) {
  const SEP = '---COMMIT---';
  const commits = [];
  const entries = log.split(SEP).filter(e => e.trim());
  for (const entry of entries) {
    const lines = entry.trim().split('\n');
    if (lines.length < 3) continue;
    commits.push({
      hash: lines[0],
      date: lines[1]?.slice(0, 10),
      subject: lines[2],
      disposicion: (lines.slice(3).join('\n').match(/Disposición:\s*(BOE-\S+)/) || [])[1] || '',
      articulos: (lines.slice(3).join('\n').match(/Artículos afectados:\s*(.+)/) || [])[1] || ''
    });
  }
  return commits;
}

// ===== INDEX =====
let lawIndex = null;
function buildIndex() {
  if (lawIndex) return lawIndex;
  const files = fs.readdirSync(LAWS_DIR).filter(f => f.endsWith('.md'));
  lawIndex = {};
  for (const file of files) {
    const content = fs.readFileSync(path.join(LAWS_DIR, file), 'utf8');
    const meta = parseFrontmatter(content);
    const id = file.replace('.md', '');
    lawIndex[id] = {
      id,
      titulo: meta.titulo || file,
      rango: meta.rango || '',
      fecha_publicacion: meta.fecha_publicacion || '',
      ultima_actualizacion: meta.ultima_actualizacion || '',
      estado: meta.estado || '',
      fuente: meta.fuente || ''
    };
  }
  return lawIndex;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const meta = {};
  match[1].split(/\r?\n/).forEach(line => {
    const m = line.match(/^([\w]+):\s*"?([^"]*)"?\s*$/);
    if (m) meta[m[1]] = m[2].trim();
  });
  return meta;
}

function getLawBody(content) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

// ===== EUR-LEX CELEX BUILDER =====
function buildCelex(type, num, year) {
  // type: 'L' (directive), 'R' (regulation), 'D' (decision)
  let yr = year;
  if (yr.length <= 2) yr = parseInt(yr) > 50 ? '19' + yr : '20' + yr;
  const paddedNum = num.padStart(4, '0');
  return `3${yr}${type}${paddedNum}`;
}

function buildEurLexUrl(celex, format) {
  if (format === 'eli-dir') {
    // Extract year and num from celex like 31992L0043
    const yr = celex.slice(1, 5);
    const num = parseInt(celex.slice(6));
    return `https://eur-lex.europa.eu/eli/dir/${yr}/${num}/oj`;
  }
  if (format === 'eli-reg') {
    const yr = celex.slice(1, 5);
    const num = parseInt(celex.slice(6));
    return `https://eur-lex.europa.eu/eli/reg/${yr}/${num}/oj`;
  }
  if (format === 'html') {
    return `https://eur-lex.europa.eu/legal-content/ES/TXT/HTML/?uri=CELEX:${celex}`;
  }
  if (format === 'pdf') {
    return `https://eur-lex.europa.eu/legal-content/ES/TXT/PDF/?uri=CELEX:${celex}`;
  }
  // Default: full info page
  return `https://eur-lex.europa.eu/legal-content/ES/ALL/?uri=CELEX:${celex}`;
}

// ===== SPARQL EUR-LEX QUERY =====
function queryEurLexSparql(celex) {
  return new Promise((resolve, reject) => {
    if (eurlexCache[celex]) return resolve(eurlexCache[celex]);

    const sparql = `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?title ?date ?inForce WHERE {
  ?work cdm:resource_legal_id_celex "${celex}" .
  OPTIONAL {
    ?work cdm:work_has_expression ?expr .
    ?expr cdm:expression_title ?title .
    ?expr cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/SPA> .
  }
  OPTIONAL { ?work cdm:resource_legal_date_document ?date . }
  OPTIONAL { ?work cdm:resource_legal_in-force "true" . BIND("true" AS ?inForce) }
}
LIMIT 1`;

    const params = new URLSearchParams({
      query: sparql,
      format: 'application/sparql-results+json'
    });

    const url = `https://publications.europa.eu/webapi/rdf/sparql?${params}`;

    https.get(url, { timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const bindings = json.results?.bindings;
          if (bindings && bindings.length > 0) {
            const b = bindings[0];
            const result = {
              celex,
              title: b.title?.value || '',
              date: b.date?.value || '',
              inForce: b.inForce?.value === 'true',
              found: true
            };
            eurlexCache[celex] = result;
            resolve(result);
          } else {
            const result = { celex, title: '', date: '', inForce: false, found: false };
            eurlexCache[celex] = result;
            resolve(result);
          }
        } catch (e) {
          resolve({ celex, title: '', date: '', inForce: false, found: false });
        }
      });
    }).on('error', () => {
      resolve({ celex, title: '', date: '', inForce: false, found: false });
    }).on('timeout', function() { this.destroy(); resolve({ celex, title: '', found: false }); });
  });
}

// ===== EXTRACT REFERENCES =====
function extractReferences(text) {
  const refs = [];
  const seen = new Set();
  let m;

  // BOE-A-YYYY-NNNNN
  const boeRe = /BOE-A-(\d{4})-(\d+)/g;
  while ((m = boeRe.exec(text)) !== null) {
    const id = m[0];
    if (!seen.has(id)) {
      seen.add(id);
      refs.push({ type: 'boe', id, label: id, url: `https://www.boe.es/diario_boe/txt.php?id=${id}` });
    }
  }

  // Ley [Organica] N/YYYY
  const leyRe = /\b(Ley(?:\s+Org[aá]nica)?)\s+(\d{1,3})\/(\d{4})/gi;
  while ((m = leyRe.exec(text)) !== null) {
    const label = `${m[1]} ${m[2]}/${m[3]}`;
    const key = label.toLowerCase();
    if (!seen.has(key)) { seen.add(key); refs.push({ type: 'ley', label, year: m[3], num: m[2] }); }
  }

  // Real Decreto[-Ley|Legislativo] N/YYYY
  const rdRe = /\b(Real\s+Decreto(?:[-\s]Ley|[\s-]Legislativo)?)\s+(\d{1,4})\/(\d{4})/gi;
  while ((m = rdRe.exec(text)) !== null) {
    const label = `${m[1]} ${m[2]}/${m[3]}`;
    const key = label.toLowerCase();
    if (!seen.has(key)) { seen.add(key); refs.push({ type: 'rd', label, year: m[3], num: m[2] }); }
  }

  // Orden [ministerial] XYZ/N/YYYY
  const ordenRe = /\b(Orden\s+\w{2,5}\/\d{1,5}\/\d{4})/gi;
  while ((m = ordenRe.exec(text)) !== null) {
    const label = m[1];
    const key = label.toLowerCase();
    if (!seen.has(key)) { seen.add(key); refs.push({ type: 'orden', label }); }
  }

  // Directivas UE - improved parsing
  const dirRe = /\bDirectiva\s+(\d{2,4})\/(\d{1,4})(?:\/(?:CEE?|UE))?/gi;
  while ((m = dirRe.exec(text)) !== null) {
    let yr = m[1], num = m[2];
    // In EU directives, usually format is year/number or number/year
    // If first part is 2 digits and second is 4 digits, swap
    if (m[1].length <= 2 && m[2].length === 4) { yr = m[2]; num = m[1]; }
    else if (m[1].length === 4) { yr = m[1]; num = m[2]; }
    else { yr = m[1].length <= 2 ? (parseInt(m[1]) > 50 ? '19' + m[1] : '20' + m[1]) : m[1]; num = m[2]; }

    const label = `Directiva ${m[1]}/${m[2]}`;
    const key = label.toLowerCase();
    if (!seen.has(key)) {
      const celex = buildCelex('L', num, yr);
      const eli = buildEurLexUrl(celex, 'eli-dir');
      const htmlUrl = buildEurLexUrl(celex, 'html');
      const allUrl = buildEurLexUrl(celex, 'all');
      seen.add(key);
      refs.push({
        type: 'eu', subtype: 'directiva', label,
        celex, year: yr, num,
        url: allUrl, eli, htmlUrl,
        pdfUrl: buildEurLexUrl(celex, 'pdf')
      });
    }
  }

  // Reglamentos UE
  const regRe = /\bReglamento\s+(?:\((?:UE|CE|CEE)\)\s+)?(?:n[uú]m\.?\s*)?(\d{1,4})\/(\d{4})/gi;
  while ((m = regRe.exec(text)) !== null) {
    const num = m[1], yr = m[2];
    const label = `Reglamento ${m[1]}/${m[2]}`;
    const key = label.toLowerCase();
    if (!seen.has(key)) {
      const celex = buildCelex('R', num, yr);
      const allUrl = buildEurLexUrl(celex, 'all');
      seen.add(key);
      refs.push({
        type: 'eu', subtype: 'reglamento', label,
        celex, year: yr, num,
        url: allUrl,
        eli: buildEurLexUrl(celex, 'eli-reg'),
        htmlUrl: buildEurLexUrl(celex, 'html'),
        pdfUrl: buildEurLexUrl(celex, 'pdf')
      });
    }
  }

  // Decisiones UE
  const decRe = /\bDecisi[oó]n\s+(?:\((?:UE|CE)\)\s+)?(?:n[uú]m\.?\s*)?(\d{1,4})\/(\d{4})/gi;
  while ((m = decRe.exec(text)) !== null) {
    const num = m[1], yr = m[2];
    const label = `Decision ${m[1]}/${m[2]}`;
    const key = label.toLowerCase();
    if (!seen.has(key)) {
      const celex = buildCelex('D', num, yr);
      seen.add(key);
      refs.push({
        type: 'eu', subtype: 'decision', label,
        celex, year: yr, num,
        url: buildEurLexUrl(celex, 'all'),
        htmlUrl: buildEurLexUrl(celex, 'html')
      });
    }
  }

  // Convenios internacionales
  const convRe = /\b(Convenio\s+(?:sobre|de|para|relativo)\s+[^,.;\n]{10,80})/gi;
  while ((m = convRe.exec(text)) !== null) {
    const label = m[1].trim();
    const key = label.toLowerCase().slice(0, 40);
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({
        type: 'intl', label: label.length > 70 ? label.slice(0, 67) + '...' : label,
        url: `https://www.google.com/search?q=${encodeURIComponent(label + ' site:boe.es OR site:un.org OR site:coe.int')}`
      });
    }
  }

  return refs;
}

function resolveReference(ref, index) {
  if (ref.type === 'boe' && index[ref.id]) return index[ref.id];
  if (ref.type === 'ley' || ref.type === 'rd') {
    const pattern = `${ref.num}/${ref.year}`;
    for (const id in index) {
      if (index[id].titulo && index[id].titulo.includes(pattern)) return index[id];
    }
  }
  return null;
}

// ===== EUR-LEX ENRICHMENT ENDPOINT =====
app.get('/api/eurlex/:celex', async (req, res) => {
  try {
    const celex = req.params.celex;
    const result = await queryEurLexSparql(celex);
    result.urls = {
      all: buildEurLexUrl(celex, 'all'),
      html: buildEurLexUrl(celex, 'html'),
      pdf: buildEurLexUrl(celex, 'pdf')
    };
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch EUR-Lex lookup
app.post('/api/eurlex/batch', async (req, res) => {
  try {
    const { celexIds } = req.body;
    if (!celexIds || !Array.isArray(celexIds)) return res.json({ results: {} });

    const results = {};
    const promises = celexIds.slice(0, 20).map(async celex => {
      const data = await queryEurLexSparql(celex);
      data.urls = {
        all: buildEurLexUrl(celex, 'all'),
        html: buildEurLexUrl(celex, 'html'),
        pdf: buildEurLexUrl(celex, 'pdf')
      };
      results[celex] = data;
    });

    await Promise.all(promises);
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== SEARCH =====
app.get('/api/search', (req, res) => {
  const { q = '', rango = '', estado = '', desde = '', hasta = '' } = req.query;
  if (!q && !rango && !estado) return res.json({ results: [], total: 0 });
  try {
    const index = buildIndex();
    const qLow = q.toLowerCase();
    const results = [];

    const candidates = Object.values(index).filter(law => {
      if (rango && law.rango !== rango) return false;
      if (estado && law.estado !== estado) return false;
      if (desde && law.fecha_publicacion < desde) return false;
      if (hasta && law.fecha_publicacion > hasta) return false;
      return true;
    });

    for (const law of candidates) {
      if (results.length >= 100) break;
      let snippet = '';
      if (q) {
        const content = fs.readFileSync(path.join(LAWS_DIR, law.id + '.md'), 'utf8');
        const contentLow = content.toLowerCase();
        if (!contentLow.includes(qLow)) continue;
        const idx = contentLow.indexOf(qLow);
        const s = Math.max(0, idx - 100), e = Math.min(content.length, idx + 200);
        snippet = '...' + content.slice(s, e).replace(/\n/g, ' ') + '...';
      }
      results.push({ ...law, snippet });
    }

    results.sort((a, b) => b.fecha_publicacion.localeCompare(a.fecha_publicacion));
    res.json({ results, total: results.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== LAW =====
app.get('/api/law/:id', (req, res) => {
  if (!isValidLawId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  const fp = path.join(LAWS_DIR, req.params.id + '.md');
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  const content = fs.readFileSync(fp, 'utf8');
  const meta = parseFrontmatter(content);
  const body = getLawBody(content);
  res.json({ meta, body, raw: content });
});

// ===== RELATIONS =====
app.get('/api/law/:id/relations', (req, res) => {
  if (!isValidLawId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const fp = path.join(LAWS_DIR, req.params.id + '.md');
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
    const content = fs.readFileSync(fp, 'utf8');
    const meta = parseFrontmatter(content);
    const body = getLawBody(content);
    const index = buildIndex();

    const rawRefs = extractReferences(body);
    const nodes = [];
    const edges = [];
    const centerId = req.params.id;

    nodes.push({
      id: centerId, label: meta.titulo || centerId,
      rango: meta.rango || '', estado: meta.estado || '',
      fecha: meta.fecha_publicacion || '', isCenter: true, level: 0
    });

    const resolvedIds = new Set();

    // Level 1: direct refs
    for (const ref of rawRefs) {
      const resolved = resolveReference(ref, index);
      if (resolved && resolved.id !== centerId && !resolvedIds.has(resolved.id)) {
        resolvedIds.add(resolved.id);
        nodes.push({
          id: resolved.id, label: resolved.titulo,
          rango: resolved.rango, estado: resolved.estado,
          fecha: resolved.fecha_publicacion, isCenter: false,
          level: 1, inDatabase: true
        });
        edges.push({ from: centerId, to: resolved.id, type: 'references', refLabel: ref.label });
      } else if (!resolved) {
        const extId = 'ext_' + ref.label.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50);
        if (!resolvedIds.has(extId)) {
          resolvedIds.add(extId);
          nodes.push({
            id: extId, label: ref.label, rango: ref.type,
            estado: '', fecha: ref.year || '', isCenter: false,
            level: 1, inDatabase: false, refType: ref.type,
            subtype: ref.subtype || '', url: ref.url || '',
            celex: ref.celex || '',
            eli: ref.eli || '', htmlUrl: ref.htmlUrl || '',
            pdfUrl: ref.pdfUrl || ''
          });
          edges.push({ from: centerId, to: extId, type: 'references', refLabel: ref.label });
        }
      }
    }

    // Reverse refs
    const thisPatterns = [];
    if (meta.titulo) { const tm = meta.titulo.match(/(\d{1,3})\/(\d{4})/); if (tm) thisPatterns.push(tm[0]); }
    thisPatterns.push(centerId);

    const allFiles = fs.readdirSync(LAWS_DIR).filter(f => f.endsWith('.md'));
    let revCount = 0;
    for (const file of allFiles.slice(0, 600)) {
      if (revCount >= 10) break;
      const fId = file.replace('.md', '');
      if (fId === centerId || resolvedIds.has(fId)) continue;
      const fContent = fs.readFileSync(path.join(LAWS_DIR, file), 'utf8');
      if (thisPatterns.some(p => fContent.includes(p))) {
        const fMeta = parseFrontmatter(fContent);
        resolvedIds.add(fId);
        nodes.push({
          id: fId, label: fMeta.titulo || fId,
          rango: fMeta.rango || '', estado: fMeta.estado || '',
          fecha: fMeta.fecha_publicacion || '', isCenter: false,
          level: 1, inDatabase: true, isReverse: true
        });
        edges.push({ from: fId, to: centerId, type: 'referenced_by', refLabel: fMeta.titulo ? fMeta.titulo.split(',')[0] : fId });
        revCount++;
      }
    }

    // Level 2: refs of refs
    const l1Ids = [...resolvedIds].filter(id => !id.startsWith('ext_'));
    for (const l1Id of l1Ids.slice(0, 5)) {
      const l1p = path.join(LAWS_DIR, l1Id + '.md');
      if (!fs.existsSync(l1p)) continue;
      const l1c = fs.readFileSync(l1p, 'utf8');
      const l1Refs = extractReferences(getLawBody(l1c));
      let l2c = 0;
      for (const ref of l1Refs) {
        if (l2c >= 3) break;
        const resolved = resolveReference(ref, index);
        if (resolved && resolved.id !== centerId && resolved.id !== l1Id && !resolvedIds.has(resolved.id)) {
          resolvedIds.add(resolved.id);
          nodes.push({
            id: resolved.id, label: resolved.titulo,
            rango: resolved.rango, estado: resolved.estado,
            fecha: resolved.fecha_publicacion, isCenter: false,
            level: 2, inDatabase: true
          });
          edges.push({ from: l1Id, to: resolved.id, type: 'references', refLabel: ref.label });
          l2c++;
        }
      }
    }

    res.json({
      center: { id: centerId, titulo: meta.titulo, rango: meta.rango },
      nodes, edges,
      totalRefs: rawRefs.length,
      rawRefs: rawRefs.slice(0, 50)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== HISTORY (async + cached) =====
app.get('/api/law/:id/history', async (req, res) => {
  if (!isValidLawId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  const id = req.params.id;
  try {
    if (historyCache[id]) return res.json({ commits: historyCache[id] });
    const log = await gitAsync([
      '-C', REPO_DIR,
      'log', '--format=---COMMIT---%n%H%n%ai%n%s%n%b',
      '--', 'spain/' + id + '.md'
    ]);
    const commits = parseHistoryLog(log);
    historyCache[id] = commits;
    res.json({ commits });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== DIFF (async + cached) =====
app.get('/api/law/:id/diff/:hash', async (req, res) => {
  const { id, hash } = req.params;
  if (!isValidLawId(id)) return res.status(400).json({ error: 'Invalid ID' });
  if (!/^[0-9a-f]+$/i.test(hash)) return res.status(400).json({ error: 'Invalid hash' });
  const cacheKey = hash + ':' + id;
  try {
    if (diffCache[cacheKey]) return res.json({ diff: diffCache[cacheKey] });
    const diff = await gitAsync([
      '-C', REPO_DIR,
      'show', hash,
      '--', 'spain/' + id + '.md'
    ]);
    diffCache[cacheKey] = diff;
    res.json({ diff });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== STATS =====
let statsCache = null;
app.get('/api/stats', (req, res) => {
  try {
    if (statsCache) return res.json(statsCache);
    const index = buildIndex();
    const rangos = {}, estados = {};
    let vigentes = 0;
    for (const law of Object.values(index)) {
      rangos[law.rango] = (rangos[law.rango] || 0) + 1;
      estados[law.estado] = (estados[law.estado] || 0) + 1;
      if (law.estado === 'vigente') vigentes++;
    }
    statsCache = { total: Object.keys(index).length, vigentes, rangos, estados };
    res.json(statsCache);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pre-build
setTimeout(() => { try { buildIndex(); console.log('Index: ' + Object.keys(lawIndex).length + ' laws'); } catch(e) { console.error(e.message); } }, 1000);

app.listen(PORT, () => console.log(`Legalize UI → http://localhost:${PORT}`));
