
const http = require('http');

const checks = [
    // Patient Service (Merged Booking + IoT)
    { name: 'Patient Service - Health', port: 8081, path: '/health', expected: 200 },
    { name: 'Patient Service - Appointments Route', port: 8081, path: '/appointments', expected: 401 }, // Auth check proves route exists
    { name: 'Patient Service - Vitals Route', port: 8081, path: '/vitals', expected: 401 },

    // Doctor Service (Merged Clinical)
    { name: 'Doctor Service - Health', port: 8082, path: '/health', expected: 200 },
    { name: 'Doctor Service - Clinical Prescriptions', port: 8082, path: '/clinical/prescriptions', method: 'GET', expected: 401 },
    { name: 'Doctor Service - Clinical EHR', port: 8082, path: '/clinical/ehr/view-url', method: 'POST', expected: 401 },
];

function check(c) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'localhost',
            port: c.port,
            path: c.path,
            method: c.method || 'GET',
            timeout: 2000
        };

        const req = http.request(options, (res) => {
            if (res.statusCode === c.expected) {
                console.log(`✅ ${c.name}: PASS (Status ${res.statusCode})`);
            } else {
                console.log(`❌ ${c.name}: FAIL (Expected ${c.expected}, Got ${res.statusCode})`);
            }
            resolve();
        });

        req.on('error', (e) => {
            console.log(`❌ ${c.name}: ERROR - ${e.message}`);
            resolve();
        });

        req.end();
    });
}

(async () => {
    console.log("=== Consolidation Verification ===");
    for (const c of checks) {
        await check(c);
    }
})();
