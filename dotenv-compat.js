'use strict';

const Module = require('module');

const originalResolveFilename = Module._resolveFilename;



Module._resolveFilename = function(request, parent, isMain, options) {
  if (request === 'dotenv') {
    return __filename;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};




module.exports = {
  config() {
    return {
      parsed: Object.keys(process.env).reduce((acc, key) => {
        acc[key] = process.env[key];
        return acc;
      }, {}),
    };
  },
  parse(src) {
    const parsed = {};
    for (const line of String(src || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      parsed[key] = value;
    }
    return parsed;
  },
};
