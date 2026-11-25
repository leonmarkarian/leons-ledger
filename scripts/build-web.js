// Builds the phone (web app) version into dist-web/ from the same source as the desktop app.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist-web');
const version = require(path.join(root, 'package.json')).version;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });

for (const f of ['app.js', 'logic.js', 'report.js', 'styles.css']) fs.copyFileSync(path.join(root, 'src', f), path.join(out, f));
for (const f of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
  fs.copyFileSync(path.join(root, 'build', f), path.join(out, 'icons', f));
}
// iOS caches home-screen icons by file name, so publish a uniquely named copy each version
fs.copyFileSync(path.join(root, 'build', 'apple-touch-icon.png'), path.join(out, `apple-touch-icon-${version}.png`));
fs.writeFileSync(path.join(out, 'web-api.js'), fs.readFileSync(path.join(root, 'web', 'web-api.js'), 'utf8').replace(/__VERSION__/g, version));

let html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
html = html
  .replace('<link rel="stylesheet" href="styles.css" />',
    `<link rel="stylesheet" href="styles.css?v=${version}" />
  <link rel="manifest" href="manifest.webmanifest" />
  <link rel="icon" type="image/png" href="icons/icon-192.png?v=${version}" />
  <link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon-${version}.png" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black" />
  <meta name="apple-mobile-web-app-title" content="Ledger" />`)
  .replace('<script src="logic.js"></script>', `<script src="web-api.js?v=${version}"></script>\n  <script src="logic.js?v=${version}"></script>`)
  .replace('<script src="report.js"></script>', `<script src="report.js?v=${version}"></script>`)
  .replace('<script src="app.js"></script>', `<script src="app.js?v=${version}"></script>`);
fs.writeFileSync(path.join(out, 'index.html'), html);

fs.writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify({
  name: "Leon's Ledger",
  short_name: 'Ledger',
  description: 'Personal income splitter and budget tracker with an AI advisor',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#000000',
  theme_color: '#000000',
  icons: [
    { src: `icons/icon-192.png?v=${version}`, sizes: '192x192', type: 'image/png' },
    { src: `icons/icon-512.png?v=${version}`, sizes: '512x512', type: 'image/png' },
    { src: `icons/icon-maskable-512.png?v=${version}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
}, null, 2));

const files = ['./', './index.html', `./styles.css?v=${version}`, `./web-api.js?v=${version}`, `./logic.js?v=${version}`, `./report.js?v=${version}`, `./app.js?v=${version}`,
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
fs.writeFileSync(path.join(out, 'sw.js'), fs.readFileSync(path.join(root, 'web', 'sw.js'), 'utf8')
  .replace('__VERSION__', version).replace('__FILES__', JSON.stringify(files)));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`Web app v${version} built in dist-web/`);
