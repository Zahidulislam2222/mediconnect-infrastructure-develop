const http = require('http');
const services = [
    { name: 'Patient (Merged)', port: 8081, path: '/health' },
    { name: 'Doctor (Merged)', port: 8082, path: '/health' },
    { name: 'Communication', port: 8084, path: '/health' }
];

function check(name, port, path, expected = 200) {
    return new Promise((resolve) => {
        const req = http.request({ hostname: 'localhost', port, path, method: 'GET', timeout: 2000 }, (res) => {
            console.log(res.statusCode === expected ? `✅ ${name}: PASS` : `❌ ${name}: FAIL (${res.statusCode})`);
            resolve();
        });
        req.on('error', () => { console.log(`❌ ${name}: OFFLINE`); resolve(); });
        req.end();
    });
}

(async () => {
    console.log("=== MediConnect 3-Service Health Check ===");
    for (const s of services) await check(s.name, s.port, s.path);
    console.log("\n=== Logic Verification ===");
    await check('Merged Booking Logic', 8081, '/appointments', 401); // 401 proves route moved to 8081
    await check('Merged Clinical Logic', 8082, '/clinical/prescriptions', 401); // 401 proves route moved to 8082
})();