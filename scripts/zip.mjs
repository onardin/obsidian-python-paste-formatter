import { execSync } from 'node:child_process';
import fs from 'node:fs';

if (!fs.existsSync('main.js')) {
  console.error('main.js not found. Run `npm run build` first.');
  process.exit(1);
}
execSync(`zip -r python-paste-formatter.zip manifest.json main.js styles.css`, { stdio: 'inherit' });
