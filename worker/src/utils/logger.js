function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(level, ...args) {
  const prefix = `[${ts()}] [${level}]`;
  if (level === 'ERROR') console.error(prefix, ...args);
  else if (level === 'WARN') console.warn(prefix, ...args);
  else console.log(prefix, ...args);
}

module.exports = {
  info: (...a) => log('INFO', ...a),
  warn: (...a) => log('WARN', ...a),
  error: (...a) => log('ERROR', ...a),
  debug: (...a) => log('DEBUG', ...a),
};
