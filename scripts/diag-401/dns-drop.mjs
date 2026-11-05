// Temporary. Answers NXDOMAIN and swallows every third query, as a lossy resolver would.
import dgram from 'node:dgram';

const server = dgram.createSocket('udp4');
let seen = 0;
server.on('message', (query, from) => {
  seen += 1;
  const dropped = seen % 3 === 0;
  console.log(new Date().toISOString(), 'query', seen, dropped ? 'dropped' : 'answered');
  if (dropped) return;
  const reply = Buffer.from(query);
  reply[2] = 0x81;
  reply[3] = 0x83;
  server.send(reply, from.port, from.address);
});
server.bind(53, process.argv[2]);
