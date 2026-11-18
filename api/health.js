'use strict';
module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    ok: true,
    platform: 'vercel',
    serverTime: Date.now()
  });
};
