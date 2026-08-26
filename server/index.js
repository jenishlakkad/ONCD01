const app = require('./app');
const env = require('./config/env');

app.listen(env.port, () => {
  console.log(`ONCD server listening on http://localhost:${env.port}`);
});
