const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  // 接続の作り直し（TCP・TLS・認証で数往復）を減らすため、使っていない接続を5分間保持する（既定は10秒）。
  // DBサーバーとの距離が遠いと、作り直しのたびに数百ミリ秒かかるため
  idleTimeoutMillis: 5 * 60 * 1000,
  keepAlive: true,
});
// 待機中の接続がDB側から切断された場合、プロセスを止めずにその接続だけを捨てる（次の要求で新しい接続を作る）
pool.on("error", () => {
  console.error("Database pool: idle connection error");
});

module.exports = pool;
