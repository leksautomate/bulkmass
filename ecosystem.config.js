module.exports = {
    apps: [{
        name: 'bulkmass',
        script: 'server.js',
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        watch: false,
        max_memory_restart: '512M',
        env: {
            NODE_ENV: 'production',
            PORT: 5000
        },
        // Logging
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        error_file: './logs/error.log',
        out_file: './logs/app.log',
        merge_logs: true,
        // Graceful shutdown
        kill_timeout: 5000,
        listen_timeout: 10000
    }]
};
