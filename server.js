import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Download standalone offline app zip bundle
app.get('/api/download-zip', (req, res) => {
  try {
    const zip = new AdmZip();
    const files = [
      'index.html',
      'style.css',
      'app.js',
      'sw.js',
      'manifest.webmanifest',
      'icon-192.png',
      'icon-512.png',
      'package.json',
      'server.js',
      'README.md'
    ];

    for (const f of files) {
      const fullPath = path.join(__dirname, f);
      if (fs.existsSync(fullPath)) {
        zip.addLocalFile(fullPath);
      }
    }

    const buffer = zip.toBuffer();
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="inpulse-300-mk2-cross-dj.zip"',
      'Content-Length': buffer.length
    });
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
