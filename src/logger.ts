const TS = () => new Date().toISOString().slice(11, 19);

const wrap = (code: string, s: string) => `\x1b[${code}m${s}\x1b[0m`;
export const dim = (s: string) => wrap('2', s);
const bold = (s: string) => wrap('1', s);
const cyan = (s: string) => wrap('36', s);
const gray = (s: string) => wrap('90', s);
const red = (s: string) => wrap('31', s);
const yellow = (s: string) => wrap('33', s);

function trunc(s: string, n = 600): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + ` … (+${one.length - n} chars)` : one;
}

let live = false;

function endLive() {
  if (live) {
    process.stdout.write('\n');
    live = false;
  }
}

/** Section header, e.g. a new upstream request. */
export function logHeader(msg: string) {
  endLive();
  console.log(`\n${dim(TS())} ${bold(msg)}`);
}

export function logInfo(label: string, msg: string) {
  endLive();
  console.log(`${dim(TS())} ${dim(label.padEnd(9))} ${msg}`);
}

/** The prompt text being sent upstream. */
export function logPrompt(text: string) {
  endLive();
  console.log(`${dim(TS())} ${dim('prompt'.padEnd(9))} ${cyan(trunc(text))}`);
}

/** Streamed model output, printed live (content or reasoning). */
export function logLive(text: string, kind: 'content' | 'reasoning' = 'content') {
  if (!text) return;
  process.stdout.write(kind === 'content' ? text : gray(text));
  live = true;
}

/** A parsed tool call being bridged back to the client (e.g. Codex). */
export function logToolCall(name: string, args: string) {
  endLive();
  console.log(`${dim(TS())} ${yellow('tool'.padEnd(9))} ${bold(name)} ${dim(trunc(args, 300))}`);
}

/** Footer line, e.g. token usage summary. */
export function logFooter(label: string, msg: string) {
  endLive();
  console.log(`${dim(TS())} ${dim(label.padEnd(9))} ${msg}`);
}

export function logError(msg: string) {
  endLive();
  console.error(`${dim(TS())} ${red('error'.padEnd(9))} ${msg}`);
}

/** Compact HTTP access log line. */
export function logHttp(method: string, path: string, status: number, ms: number) {
  console.log(`${dim(TS())} ${dim(method.padEnd(5))} ${path.padEnd(24)} ${status} ${dim(`${ms}ms`)}`);
}
