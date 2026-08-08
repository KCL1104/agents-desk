/**
 * Profiles as the frontend handles them: the args string people type, and
 * the array the backend stores. Kept apart from any component because both
 * launch dialogs and the profile editor need the same two conversions, and
 * they have to agree with each other exactly.
 */

/** Split a flag string the way a shell would, honouring quotes. */
export function splitArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The inverse, for showing stored args back in an editable field. */
export function joinArgs(args: readonly string[]): string {
  return args.map((a) => (/\s/.test(a) || a === '' ? `"${a}"` : a)).join(' ');
}
