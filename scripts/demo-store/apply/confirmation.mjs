import { createInterface } from "node:readline";

export const DEMO_RESET_CONFIRMATION = "RESET SCALIUS MARKET DEMO";

function question(prompt, { input, output }) {
  return new Promise((resolve) => {
    const terminal = createInterface({ input, output, terminal: true });
    terminal.question(prompt, (answer) => {
      terminal.close();
      resolve(String(answer).trim());
    });
  });
}

export async function readDemoApplyConfirmation({
  intentFingerprint,
  input = process.stdin,
  output = process.stdout,
}) {
  if (!input.isTTY || !output.isTTY) throw new Error("Demo apply confirmation requires an interactive terminal.");
  const reset = await question(`Type ${DEMO_RESET_CONFIRMATION} to authorize reconciliation: `, { input, output });
  if (reset !== DEMO_RESET_CONFIRMATION) throw new Error("Demo reset confirmation did not match; no writes were authorized.");
  const fingerprint = await question("Paste the full intent fingerprint shown above: ", { input, output });
  if (fingerprint !== intentFingerprint) throw new Error("Intent fingerprint confirmation did not match; no writes were authorized.");
  return { confirmed: true, resetConfirmed: true, intentFingerprint };
}
