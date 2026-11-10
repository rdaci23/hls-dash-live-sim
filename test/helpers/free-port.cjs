// A port for a server the test starts next. Asking the OS for port 0, closing
// and reusing the number races with every other test process doing the same.
// Each process instead draws from its own block, below the ephemeral ranges
// of Linux (32768+) and macOS (49152+), and never hands out a number twice
// while it still has unused ones.
const net = require("node:net");
const BASE = 10000, BLOCK = 100, BLOCKS = 200;
const start = BASE + (process.pid % BLOCKS) * BLOCK;
let next = 0;
function bindable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
module.exports = async function freePort() {
  for (let tries = 0; tries < BLOCK; tries++) {
    const port = start + (next++ % BLOCK);
    if (await bindable(port)) return port;
  }
  throw new Error("No free port left in this test process's block");
};
