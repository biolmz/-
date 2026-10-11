// PM2 配置：pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'sensory-eval',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      watch: false,
      max_memory_restart: '300M',
      env: {
        PORT: 8200,
        HOST: '0.0.0.0',
        NODE_ENV: 'production',
        // 建议在此设置管理密码，避免使用默认密码：
        // ADMIN_PASSWORD: 'change-me-please',
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
