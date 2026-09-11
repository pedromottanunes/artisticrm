import webpush from 'web-push';
// Run locally. Never save private keys to the repository or browser configuration.
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.info(
  `PUSH_ENABLED=true\nVAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\nVAPID_SUBJECT=mailto:SEU_EMAIL_DE_CONTATO`,
);
