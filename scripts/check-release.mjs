import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('manifest.json','utf8'));
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));

if (manifest.version !== pkg.version) {
  console.error(`Version mismatch: manifest.json=${manifest.version} package.json=${pkg.version}`);
  process.exit(1);
}
console.log('Version check OK.');
