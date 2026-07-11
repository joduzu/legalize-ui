const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

for (const file of ['index.html', 'public/index.html']) {
  const html = fs.readFileSync(file, 'utf8');
  for (const needle of ['<!DOCTYPE html>', '<script>', '</script>', 'function apiGet', 'STATIC_LAWS']) {
    if (!html.includes(needle)) {
      throw new Error(`${file} is missing ${needle}`);
    }
  }

  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const tmp = path.join(os.tmpdir(), `${path.basename(file)}.js`);
  fs.writeFileSync(tmp, script);
  execFileSync('node', ['--check', tmp], { stdio: 'inherit' });
}

const root = fs.readFileSync('index.html', 'utf8');
const publicIndex = fs.readFileSync('public/index.html', 'utf8');
if (root !== publicIndex) {
  throw new Error('index.html and public/index.html must stay identical');
}

console.log('HTML checks passed');
