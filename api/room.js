// Vercel Serverless Function: GET /api/room
// Turns the visitor's public IP into an anonymous room code, so devices on the
// same Wi-Fi / network (same public IP) find each other automatically.
// The IP itself is never returned or stored.
const crypto = require('crypto');

function expandV6(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const missing = 8 - h.length - t.length;
  return [...h, ...Array(Math.max(0, missing)).fill('0'), ...t].map(x => x.padStart(4, '0'));
}

function networkKey(raw) {
  let ip = String(raw || '').split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.includes(':')) {
    // IPv6: every device gets its own address, so group by the /64 network prefix
    return 'v6:' + expandV6(ip.split('%')[0]).slice(0, 4).join(':');
  }
  return 'v4:' + ip;
}

module.exports = (req, res) => {
  const h = req.headers;
  const ip = h['x-vercel-forwarded-for'] || h['x-forwarded-for'] || h['x-real-ip'] || (req.socket && req.socket.remoteAddress) || '';
  const salt = process.env.ROOM_SALT || 'localsend-web';
  const room = crypto.createHash('sha256').update(salt + '|' + networkKey(ip)).digest('hex').slice(0, 8).toUpperCase();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ room }));
};
