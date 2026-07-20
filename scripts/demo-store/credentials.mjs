import { createInterface } from "node:readline";

function question(prompt, { input, output }) {
  return new Promise((resolve) => {
    const terminal = createInterface({ input, output, terminal: true });
    terminal.question(prompt, (answer) => {
      terminal.close();
      resolve(answer);
    });
  });
}

export function readHiddenLine(prompt, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Demo-store credentials require an interactive terminal.");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return finish(new Error("Credential entry cancelled."));
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export async function readAdminCredentials({ input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Demo-store credentials require an interactive terminal.");
  }
  const email = String(await question("Admin email: ", { input, output })).trim();
  const password = await readHiddenLine("Admin password: ", { input, output });
  if (!email || !email.includes("@")) throw new Error("A valid admin email is required.");
  if (!password) throw new Error("Admin password is required.");
  return { email, password };
}
