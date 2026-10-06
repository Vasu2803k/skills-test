#!/usr/bin/env node
// Run LibreOffice headless with an isolated, throwaway user profile.
// Bare `soffice` fails in containers and shared environments: the default
// profile may be locked by another run or unwritable for the pod user, and
// without a display server some builds abort. Every call here gets its own
// temp profile, the headless VCL plugin, and a hard timeout.
//
// CLI:    node soffice.js --headless --convert-to pdf file.docx
// Module: const { runSoffice } = require('./soffice');
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

function runSoffice(args, opts = {}) {
  const { timeoutMs = 120000, cwd } = opts;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-profile-'));
  const argv = [`-env:UserInstallation=${pathToFileURL(profile)}`, ...args];
  try {
    const res = spawnSync('soffice', argv, {
      timeout: timeoutMs,
      encoding: 'utf8',
      cwd,
      env: { ...process.env, SAL_USE_VCLPLUGIN: 'svp', HOME: process.env.HOME || os.tmpdir() },
    });
    if (res.error && res.error.code === 'ENOENT') {
      throw new Error('soffice not found on PATH — LibreOffice must be installed in this environment');
    }
    if (res.error) throw res.error;
    return res;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

module.exports = { runSoffice };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node soffice.js <soffice arguments...>');
    process.exit(2);
  }
  const res = runSoffice(args);
  process.stdout.write(res.stdout || '');
  process.stderr.write(res.stderr || '');
  process.exit(res.status === null ? 1 : res.status);
}
