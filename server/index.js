const app = require('./app');
const env = require('./config/env');

app.listen(env.port, () => {
  console.log(`ONCD server listening on http://localhost:${env.port}`);
  // Open the mail connection and load the brand details now, so the first
  // verification code doesn't pay for the SMTP handshake.
  require('./lib/mailer').warmUp();
  require('./lib/emailTemplates').getBrand().catch(() => {});
});
