const fs = require('fs');
const path = require('path');

console.log('--- VPS Troubleshooting Script ---');
console.log('Node Version:', process.version);
console.log('CWD:', process.cwd());

const localPath = path.resolve(__dirname, 'whisk-api-source/dist/index.js');
console.log('Checking local path:', localPath);

try {
    if (fs.existsSync(localPath)) {
        console.log('[OK] file exists');
        const stats = fs.statSync(localPath);
        console.log('Size:', stats.size, 'bytes');

        // Try importing it
        import('file://' + localPath.replace(/\\/g, '/')).then(mod => {
            console.log('[OK] Import successful');
            console.log('Exports:', Object.keys(mod));
        }).catch(err => {
            console.error('[FAIL] Import failed:', err.message);
            console.error(err.stack);
        });

    } else {
        console.error('[FAIL] File does NOT exist at local path');
        console.log('Listing whisk-api-source directory:');
        try {
            const dir = path.join(__dirname, 'whisk-api-source');
            if (fs.existsSync(dir)) {
                console.log(fs.readdirSync(dir));
                const distDir = path.join(dir, 'dist');
                if (fs.existsSync(distDir)) {
                    console.log('dist contents:', fs.readdirSync(distDir));
                } else {
                    console.log('dist directory missing');
                }
            } else {
                console.log('whisk-api-source directory missing');
            }
        } catch (e) {
            console.log('Error listing directory:', e.message);
        }
    }
} catch (e) {
    console.error('Error checking file:', e.message);
}

// Check package installation
console.log('\nChecking npm package @rohitaryal/whisk-api...');
try {
    const pkgPath = require.resolve('@rohitaryal/whisk-api');
    console.log('[OK] Package resolved at:', pkgPath);
} catch (e) {
    console.log('[WARN] Package resolution failed:', e.message);
}

console.log('--- End of Script ---');
