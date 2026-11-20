'use strict';

const fs = require('node:fs');

const validDateKey = (key) => typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key);
const validMonth = (key) => typeof key === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(key);
const monthOf = (key) => typeof key === 'string' ? key.slice(0, 7) : '';
const completionDate = (done, origin) => validDateKey(done.completedDateKey) ? done.completedDateKey : origin;

function localDateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function storedMonths(directory, legacyDays) {
  const months = new Set(Object.keys(legacyDays).map(monthOf).filter(validMonth));
  let files;
  try {
    files = fs.readdirSync(directory);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    files = [];
  }
  for (const file of files) {
    if (file.endsWith('.json') && validMonth(file.slice(0, -5))) months.add(file.slice(0, -5));
  }
  return [...months].sort();
}

module.exports = { validDateKey, validMonth, monthOf, completionDate, localDateKey, storedMonths };
