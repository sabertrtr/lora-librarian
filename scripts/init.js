#!/usr/bin/env node
// The install step:  npm run init
//
// Creates the data directory (WILDCARDS_DIR) and seeds library.yaml,
// staging.json and promptbuilder.json where they are missing, and creates
// DOWNLOAD_DIR if it is missing. Sets owner-only modes: 0700 on the data
// directory, 0600 on its three files and on this checkout's .env (a chmod
// only; the installer never rewrites .env). Never overwrites a file that exists; prints
// every path it created or kept, so a mistyped setting is visible here, at
// install, instead of becoming an empty library at boot. The server never
// creates any of these (src/locations.js).
//
// Reads the same settings the server does: the environment, then the .env in
// this checkout (dotenv does not override a variable that is already set).

const path = require('path');
const ENV_FILE = path.resolve(__dirname, '../.env');
require('dotenv').config({ path: ENV_FILE });
const locations = require('../src/locations');

try {
  const locs = locations.resolve(process.env);
  for (const line of locations.install(locs, { envFile: ENV_FILE })) console.log(line);
  locations.checkEnvFile(ENV_FILE);
  locations.check(locs);
  console.log('init: done; the service can start.');
} catch (e) {
  if (!(e instanceof locations.LocationError)) throw e;
  console.error(`init: refused: ${e.message}`);
  process.exit(1);
}
