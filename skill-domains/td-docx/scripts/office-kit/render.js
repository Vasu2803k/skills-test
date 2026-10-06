#!/usr/bin/env node
// Render a document (.pptx/.docx/.xlsx/.pdf and friends) to one PNG per page
// for visual QA. Non-PDF inputs are converted to PDF via LibreOffice first,
// then rasterized with pdftoppm (Poppler).
//
// Usage: node render.js <file> [outdir]
//
// Prints the absolute path of every PNG it wrote, one per line, in page
// order. Re-running with the same outdir removes that document's stale
// images first, so the listing always reflects the current file.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { runSoffice } = require('./soffice');

function renderToImages(file, outdir, dpi = 150) {
  const input = path.resolve(file);
  if (!fs.existsSync(input)) throw new Error(`No such file: ${input}`);
  const out = path.resolve(outdir || path.dirname(input));
  fs.mkdirSync(out, { recursive: true });

  const stem = path.basename(input).replace(/\.[^.]+$/, '');
  let pdf = input;
  if (path.extname(input).toLowerCase() !== '.pdf') {
    const res = runSoffice(['--headless', '--convert-to', 'pdf', '--outdir', out, input]);
    pdf = path.join(out, `${stem}.pdf`);
    if (!fs.existsSync(pdf)) {
      throw new Error(`LibreOffice did not produce ${pdf}\n${res.stderr || res.stdout || ''}`);
    }
  }

  const prefix = path.join(out, `${stem}-page`);
  for (const old of fs.readdirSync(out)) {
    if (old.startsWith(`${stem}-page-`) && old.endsWith('.png')) fs.unlinkSync(path.join(out, old));
  }
  const ppm = spawnSync('pdftoppm', ['-png', '-r', String(dpi), pdf, prefix], { encoding: 'utf8' });
  if (ppm.error && ppm.error.code === 'ENOENT') {
    throw new Error('pdftoppm not found on PATH — Poppler must be installed in this environment');
  }
  if (ppm.status !== 0) throw new Error(`pdftoppm failed: ${ppm.stderr}`);

  const images = fs
    .readdirSync(out)
    .filter((f) => f.startsWith(`${stem}-page-`) && f.endsWith('.png'))
    .sort()
    .map((f) => path.join(out, f));
  if (images.length === 0) throw new Error('pdftoppm produced no images');
  return images;
}

module.exports = { renderToImages };

if (require.main === module) {
  const [file, outdir] = process.argv.slice(2);
  if (!file) {
    console.error('Usage: node render.js <file> [outdir]');
    process.exit(2);
  }
  try {
    for (const img of renderToImages(file, outdir)) console.log(img);
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(1);
  }
}
