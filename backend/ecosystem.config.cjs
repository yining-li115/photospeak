// PM2 ecosystem file. Run on the server:
//   pm2 start ecosystem.config.cjs --env production
//   pm2 save
//   pm2 startup   (then run the command it prints)
//
// PM2 reads PHOTOSPEAK_* env from the host (set them via systemd /
// shell profile / your secret manager) and forwards them as the
// names the app expects. Don't put real secrets in this file.

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
        PORT: 3000,
        // These should be set on the host (export PHOTOSPEAK_* in
        // ~/.bashrc or a systemd EnvironmentFile) so they don't end
        // up in this committed file.
        MIMO_API_KEY: process.env.PHOTOSPEAK_MIMO_API_KEY,
        DASHSCOPE_API_KEY: process.env.PHOTOSPEAK_DASHSCOPE_API_KEY,
        APP_SHARED_TOKEN: process.env.PHOTOSPEAK_APP_SHARED_TOKEN,
      },
    },
  ],
};
