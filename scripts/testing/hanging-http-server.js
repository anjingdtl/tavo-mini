const net = require('net');

const port = Number(process.env.SHINE_WRITER_E2E_STUB_PORT || 8000);
const sockets = new Set();

const server = net.createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => sockets.delete(socket));
});

function close() {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
}

process.on('SIGINT', close);
process.on('SIGTERM', close);

server.listen(port, '0.0.0.0', () => {
  console.log(`ShineWriter E2E hanging HTTP stub listening on ${port}`);
});
