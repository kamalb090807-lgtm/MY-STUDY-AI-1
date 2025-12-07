const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/ping',
  method: 'GET'
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log('Backend /api/ping response:');
    console.log('Status:', res.statusCode);
    console.log('Data:', data);
    process.exit(res.statusCode === 200 ? 0 : 1);
  });
});

req.on('error', (err) => {
  console.error('Backend error:', err.message);
  process.exit(1);
});

req.end();
