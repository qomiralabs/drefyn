// Temporary. Times the banner of one SMTP session after another.
import net from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';

const port = Number(process.argv[2]);
const until = Date.now() + Number(process.argv[3]);
const banner = () =>
  new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect(port, '127.0.0.1');
    socket.once('data', () => {
      const ms = performance.now() - started;
      socket.end('QUIT\r\n');
      resolve(ms);
    });
    socket.once('error', () => resolve(-1));
  });

const times = [];
while (Date.now() < until) {
  const ms = await banner();
  times.push(ms);
  if (ms < 0 || ms > 250) console.log(new Date().toISOString(), 'slow', Math.round(ms));
  await wait(100);
}
times.sort((a, b) => a - b);
const at = (share) => Math.round(times[Math.floor((times.length - 1) * share)]);
console.log(
  'sessions',
  times.length,
  'p50',
  at(0.5),
  'p99',
  at(0.99),
  'p999',
  at(0.999),
  'max',
  at(1),
);
