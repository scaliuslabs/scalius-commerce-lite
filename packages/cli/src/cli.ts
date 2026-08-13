#!/usr/bin/env node
import { createRuntime } from "./runtime.js";
import { runProgram } from "./program.js";

process.exitCode = await runProgram(createRuntime(), process.argv.slice(2));
