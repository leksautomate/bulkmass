const fs = require('fs');
const { Whisk } = require('@rohitaryal/whisk-api');

// Simple 1x1 png base64
const testImage = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function test() {
    try {
        // Find cookie
        const cookieStr = "bulkmass_cookie"; // we don't have this available directly unless we read it from somewhere...
        // Wait, app state is local storage. I'll read it from an env var or just prompt the user?
        // Wait, the user already has it in the running app! Let's modify server.js to log instead!
    } catch (e) {
        console.error(e);
    }
}
test();
