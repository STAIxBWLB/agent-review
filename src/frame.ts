import { terminalText } from "@staix/cli-output";

// Ported from agent-hub's envelope sanitizer.
export function sanitize(body: string): string {
  return body.replace(/^(?=\s*(\[agent-hub\b|--- from ))/gim, "> ");
}

/** Give every untrusted physical line a prefix, including apparent brief headers. */
export function frame(text: string): string {
  return terminalText(sanitize(text)).split(/\r?\n|\p{Zl}|\p{Zp}/u).map(line => `> ${line}`).join("\n");
}
