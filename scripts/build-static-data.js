const fs = require('fs');
const path = require('path');

const lawsDir = process.env.LAWS_DIR || path.join(__dirname, '..', '..', 'legalize-es', 'spain');
const rootDir = path.join(__dirname, '..');
const outDirs = [path.join(rootDir, 'data'), path.join(rootDir, 'public', 'data')];

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([\w]+):\s*"?([^"]*)"?\s*$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return meta;
}

function getLawBody(content) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

if (!fs.existsSync(lawsDir)) {
  throw new Error(`No existe LAWS_DIR: ${lawsDir}`);
}

const files = fs.readdirSync(lawsDir).filter(file => file.endsWith('.md')).sort();
const laws = files.map(file => {
  const content = fs.readFileSync(path.join(lawsDir, file), 'utf8');
  const meta = parseFrontmatter(content);
  const body = getLawBody(content);
  const id = file.replace(/\.md$/, '');
  return {
    id,
    meta: {
      titulo: meta.titulo || file,
      rango: meta.rango || '',
      fecha_publicacion: meta.fecha_publicacion || '',
      ultima_actualizacion: meta.ultima_actualizacion || '',
      estado: meta.estado || '',
      fuente: meta.fuente || ''
    },
    body,
    searchText: `${meta.titulo || file} ${meta.rango || ''} ${meta.estado || ''} ${body}`.toLowerCase()
  };
});

const payload = JSON.stringify({ generatedAt: new Date().toISOString(), total: laws.length, laws });
for (const outDir of outDirs) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'laws.json'), payload);
}

console.log(`Generated static data for ${laws.length} laws from ${lawsDir}`);
