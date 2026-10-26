import { type ParseArgsConfig, parseArgs } from "node:util";

/** Flags for one command; unknown ones are an error. */
export function parse<O extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: O) {
  return parseArgs({ args, options: { ...options, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
}
