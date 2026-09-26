import http from 'node:http';
import handler from './api/server.ts';

const srv = http.createServer(handler);
srv.listen(0, () => {
  const addr = srv.address();
  console.log(
    `test server on http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`,
  );
});
process.on('SIGINT', () => process.exit(0));
