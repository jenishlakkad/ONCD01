const app = require('./app');
const env = require('./config/env');

app.listen(env.port, () => {
  console.log(`ONCD server listening on http://localhost:${env.port}`);
  // A guessable session secret lets anyone forge a login cookie.
  const secret = String(env.sessionSecret || '');
  if (secret.length < 32 || /change|replace|secret|example/i.test(secret)) {
    console.error('[security] SESSION_SECRET is weak or a placeholder — set a long random value (e.g. 64 random characters) in your hosting environment settings.');
  }
  // Open the mail connection and load the brand details now, so the first
  // verification code doesn't pay for the SMTP handshake.
  require('./lib/mailer').warmUp();
  require('./lib/emailTemplates').getBrand().catch(() => {});
});
