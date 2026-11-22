// Usage: node tools/hash-password.js   (type the password; it is not echoed)
// Prints a scrypt hash to put in LINKPILOT_USERS as  username:<hash>
import readline from 'node:readline';
import { hashPassword } from '../auth.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
if (process.stdin.isTTY) {
  rl._writeToOutput = (s) => { if (!s.includes('Password')) rl.output.write('*'); else rl.output.write(s); };
}
rl.question('Password: ', (pw) => {
  rl.close();
  if (!pw || pw.length < 8) { console.error('\nUse at least 8 characters.'); process.exit(1); }
  console.log(`\n${hashPassword(pw)}`);
});
