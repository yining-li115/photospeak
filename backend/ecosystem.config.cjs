// PM2 ecosystem file. Run on the server:
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup   (then run the command it prints)
//
// Secrets live in backend/.env (gitignored). The app loads it via
// `import 'dotenv/config'` at startup, so we don't pass anything
// sensitive through this committed file.

module.exports = {
  apps: [
    {
      name: 'photospeak-api',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
