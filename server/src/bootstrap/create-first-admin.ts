import "../config/load-env";
import readline from "node:readline";
import { prisma } from "../db/prisma";
import { AppError } from "../shared/errors/app-error";
import { AdminBootstrapInputSchema } from "../modules/auth/auth.schema";
import { createFirstAdmin } from "../modules/auth/auth.service";

const KEY_EOT = ""; // Ctrl-D
const KEY_ETX = ""; // Ctrl-C
const KEY_DEL = ""; // DEL (most terminals' backspace)
const KEY_BS = "\b"; // BS (some terminals'/OSes' backspace)

function promptVisible(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);

    let value = "";
    const isRawCapable = typeof stdin.setRawMode === "function";
    if (isRawCapable) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding("utf8");

    const onData = (char: string): void => {
      if (char === "\n" || char === "\r" || char === KEY_EOT) {
        stdin.removeListener("data", onData);
        if (isRawCapable) {
          stdin.setRawMode(false);
        }
        stdin.pause();
        process.stdout.write("\n");
        resolve(value);
        return;
      }

      if (char === KEY_ETX) {
        process.stdout.write("\n");
        process.exit(1);
      }

      if (char === KEY_DEL || char === KEY_BS) {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }

      value += char;
      process.stdout.write("*");
    };

    stdin.on("data", onData);
  });
}

async function resolveField(envValue: string | undefined, question: string, hidden: boolean): Promise<string> {
  if (envValue !== undefined && envValue.length > 0) {
    return envValue;
  }

  if (!process.stdin.isTTY) {
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Missing required input and no interactive terminal is available. Set the corresponding environment variable instead.",
    });
  }

  return hidden ? promptHidden(question) : promptVisible(question);
}

async function main(): Promise<void> {
  const rawInput = {
    email: await resolveField(process.env.ADMIN_EMAIL, "Admin email: ", false),
    firstName: await resolveField(process.env.ADMIN_FIRST_NAME, "Admin first name: ", false),
    lastName: await resolveField(process.env.ADMIN_LAST_NAME, "Admin last name: ", false),
    phone: process.env.ADMIN_PHONE || undefined,
    employeeNumber: await resolveField(process.env.ADMIN_EMPLOYEE_NUMBER, "Admin employee number: ", false),
    password: await resolveField(process.env.ADMIN_PASSWORD, "Admin password: ", true),
  };

  const parsed = AdminBootstrapInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    console.error("[admin:create] Invalid input:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const result = await createFirstAdmin(parsed.data);

  console.log("[admin:create] First Admin created successfully.");
  console.log(`  id:              ${result.user.id}`);
  console.log(`  email:           ${result.user.email}`);
  console.log(`  role:            ${result.user.role.code}`);
  console.log(`  employee number: ${result.employeeNumber}`);
}

main()
  .catch((error) => {
    if (error instanceof AppError) {
      console.error(`[admin:create] Failed: ${error.message}`);
    } else {
      console.error("[admin:create] Failed with an unexpected error.");
      console.error(error);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
