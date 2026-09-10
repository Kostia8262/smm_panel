/**
 * PM2: веб-морда и воркер — два процесса.
 *
 * Разделение не косметическое: публикация видео может занять минуты, и
 * держать её в том же процессе, что интерфейс, значит однажды получить
 * «планировщик не открывается», пока уходит один тяжёлый пост.
 */

module.exports = {
  apps: [
    {
      name: 'smm-web',
      script: 'src/server.js',
      cwd: __dirname,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '300M',
      autorestart: true,
    },
    {
      name: 'smm-worker',
      script: 'src/queue/worker.js',
      cwd: __dirname,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '300M',
      autorestart: true,
      // Воркер и веб пишут в одну базу SQLite: включён WAL, но второй
      // экземпляр воркера всё равно не нужен — обработает один и тот же пост.
      instances: 1,
    },
  ],
};
