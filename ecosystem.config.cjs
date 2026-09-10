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
      // Строго fork и один экземпляр: воркер и веб пишут в одну базу SQLite.
      // От `instances` PM2 переводит процесс в cluster mode, а второй воркер
      // возьмётся за тот же пост и опубликует его дважды.
      exec_mode: 'fork',
    },
  ],
};
